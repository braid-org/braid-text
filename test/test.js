#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
const http = require('http')
const {fetch: braid_fetch} = require('braid-http')
const defineTests = require('./tests.js')
const defineCursorTests = require('./cursor-tests.js')

// Parse command line arguments
const args = process.argv.slice(2)
const mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
const portArg = args.find(arg => arg.startsWith('--port='))?.split('=')[1]
    || args.find(arg => !arg.startsWith('-') && !isNaN(arg))
const port = portArg || 8889
const filterArg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --port=PORT            Specify port number (default: 8889)
  PORT                   Port number as positional argument
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --help, -h             Show this help message

Examples:
  node test.js                         # Run all tests in console
  node test.js --filter="sync"         # Run only tests with "sync" in name
  node test.js --grep="digest"         # Run only tests with "digest" in name
  node test.js --browser               # Start browser test server
  node test.js --browser --port=9000
  node test.js -b 9000                # Short form with port
`)
    process.exit(0)
}

// ============================================================================
// Shared Server Code
// ============================================================================

function createTestServer(options = {}) {
    const {
        port = 8889,
        runTests = false,
        logRequests = false
    } = options

    const braid_text = require(`${__dirname}/../server.js`)
    braid_text.db_folder = `${__dirname}/test_db_folder`

    const braid_text2 = braid_text.create_braid_text()
    braid_text2.db_folder = null

    const server = http.createServer(async (req, res) => {
        if (logRequests) {
            console.log(`${req.method} ${req.url}`)
        }

        // Free the CORS
        braid_text.free_cors(res)
        if (req.method === 'OPTIONS') return

        if (req.url.startsWith('/have_error')) {
            res.statusCode = 569
            return res.end('error')
        }

        if (req.url.startsWith('/unauthorized') && req.method === 'PUT') {
            res.statusCode = 401
            return res.end('Unauthorized')
        }

        if (req.url.startsWith('/forbidden') && req.method === 'PUT') {
            res.statusCode = 403
            return res.end('Forbidden')
        }

        if (req.url.startsWith('/server_error') && req.method === 'PUT') {
            res.statusCode = 500
            return res.end('Internal Server Error')
        }

        if (req.url.startsWith('/404')) {
            res.statusCode = 404
            return res.end('Not Found')
        }

        if (req.url.startsWith('/eval')) {
            var body = await new Promise(done => {
                var chunks = []
                req.on('data', chunk => chunks.push(chunk))
                req.on('end', () => done(Buffer.concat(chunks)))
            })
            try {
                eval('' + body)
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end(`Error: ${error.message}`)
            }
            return
        }

        if (req.url.startsWith('/test.html')) {
            let parts = req.url.split(/[\?&=]/g)

            if (parts[1] === 'check') {
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" })
                return res.end(JSON.stringify({
                    checking: parts[2],
                    result: (await braid_text.get(parts[2])) != null
                }))
            } else if (parts[1] === 'dt_create_bytes_big_name') {
                try {
                    braid_text.dt_create_bytes('x'.repeat(1000000) + '-0', [], 0, 0, 'hi')
                    return res.end(JSON.stringify({ ok: true }))
                } catch (e) {
                    return res.end(JSON.stringify({ ok: false, error: '' + e }))
                }
            } else if (parts[1] === 'dt_create_bytes_many_names') {
                try {
                    braid_text.dt_create_bytes('hi-0', new Array(1000000).fill(0).map((x, i) => `x${i}-0`), 0, 0, 'hi')
                    return res.end(JSON.stringify({ ok: true }))
                } catch (e) {
                    return res.end(JSON.stringify({ ok: false, error: '' + e }))
                }
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })
            require("fs").createReadStream(`${__dirname}/test.html`).pipe(res)
            return
        }

        // Serve tests.js file for browser
        if (req.url.startsWith('/tests.js')) {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" })
            require("fs").createReadStream(`${__dirname}/tests.js`).pipe(res)
            return
        }

        // Now serve the collaborative text!
        braid_text.serve(req, res)
    })

    return {
        server,
        start: () => new Promise((resolve) => {
            server.listen(port, 'localhost', () => {
                if (runTests) {
                    console.log(`Test server running on http://localhost:${port}`)
                } else {
                    console.log(`serving: http://localhost:${port}/test.html`)
                }
                resolve()
            })
        }),
        port
    }
}

// ============================================================================
// Console Test Mode (Node.js)
// ============================================================================

async function runConsoleTests() {
    // Test tracking
    let totalTests = 0
    let passedTests = 0
    let failedTests = 0

    // Handle unhandled rejections during tests (some tests intentionally cause errors)
    const unhandledRejections = []
    process.on('unhandledRejection', (reason, promise) => {
        // Collect but don't crash - some tests intentionally trigger errors
        unhandledRejections.push({ reason, promise })
    })

    // Node.js test runner implementation
    // Store tests to run sequentially instead of in parallel
    const testsToRun = []

    function runTest(testName, testFunction, expectedResult) {
        // Apply filter if specified
        if (filterArg && !testName.toLowerCase().includes(filterArg.toLowerCase())) {
            return // Skip this test
        }

        totalTests++
        testsToRun.push({ testName, testFunction, expectedResult })
    }

    // Create a braid_fetch wrapper that points to localhost
    function createBraidFetch(baseUrl) {
        return async (url, options = {}) => {
            const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`
            return braid_fetch(fullUrl, options)
        }
    }

    console.log('Starting braid-text tests...\n')

    // Create and start the test server
    const testServer = createTestServer({
        port,
        runTests: true,
        logRequests: false
    })

    await testServer.start()

    // Create braid_fetch bound to test server
    const testBraidFetch = createBraidFetch(`http://localhost:${port}`)

    // Load the real diamond-types module for Node.js
    const { Doc, OpLog } = require('@braid.org/diamond-types-node')

    // Define globals needed for some tests
    global.Doc = Doc
    global.OpLog = OpLog
    global.dt_p = Promise.resolve() // No initialization needed for Node.js version
    global.fetch = testBraidFetch
    global.AbortController = AbortController
    global.crypto = require('crypto').webcrypto

    // Run all tests
    defineTests(runTest, testBraidFetch)
    defineCursorTests(runTest, testBraidFetch)

    // Run tests sequentially (not in parallel) to avoid conflicts
    var test_timeout_ms = 15000
    for (const { testName, testFunction, expectedResult } of testsToRun) {
        try {
            const result = await Promise.race([
                testFunction(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`test timed out after ${test_timeout_ms/1000}s`)),
                        test_timeout_ms))
            ])
            if (result == expectedResult) {
                passedTests++
                console.log(`✓ ${testName}`)
            } else {
                failedTests++
                console.log(`✗ ${testName}`)
                console.log(`  Expected: ${expectedResult}`)
                console.log(`  Got: ${result}`)
            }
        } catch (error) {
            failedTests++
            console.log(`✗ ${testName}`)
            console.log(`  Error: ${error.message || error}`)
        }
    }

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
    if (failedTests === 0 && !args.includes('fuzz') && !args.includes('all')) {
        console.log(`\nBasic tests complete. Consider 'npm test -- fuzz' for fuzz tests, or 'npm test -- all' for everything.`)
    }
    console.log('='.repeat(50))

    // Run yjs-text unit tests (direct API, no HTTP)
    var braid_text = require(`${__dirname}/../server.js`)
    var yjs_unit_tests = [
        ['yjs-text: parse exclusive range', () => {
            var p = braid_text.parse_yjs_range('(42-5:73-2)')
            return JSON.stringify(p)
        }, '{"inclusive":false,"left":{"client":42,"clock":5},"right":{"client":73,"clock":2}}'],

        ['yjs-text: parse null origins', () => {
            return JSON.stringify(braid_text.parse_yjs_range('(:)'))
        }, '{"inclusive":false,"left":null,"right":null}'],

        ['yjs-text: parse null left origin', () => {
            return JSON.stringify(braid_text.parse_yjs_range('(:73-2)'))
        }, '{"inclusive":false,"left":null,"right":{"client":73,"clock":2}}'],

        ['yjs-text: parse null right origin', () => {
            return JSON.stringify(braid_text.parse_yjs_range('(42-5:)'))
        }, '{"inclusive":false,"left":{"client":42,"clock":5},"right":null}'],

        ['yjs-text: parse inclusive range (delete)', () => {
            return JSON.stringify(braid_text.parse_yjs_range('[42-5:42-8]'))
        }, '{"inclusive":true,"left":{"client":42,"clock":5},"right":{"client":42,"clock":8}}'],

        ['yjs-text: parse large client IDs', () => {
            var p = braid_text.parse_yjs_range('(3847291042-5:1923847561-2)')
            return p.left.client + ',' + p.right.client
        }, '3847291042,1923847561'],

        ['yjs-text: reject mixed brackets', () => {
            return String(braid_text.parse_yjs_range('(42-5:73-2]'))
        }, 'null'],


        ['yjs-text: reject inclusive with no IDs', () => {
            return String(braid_text.parse_yjs_range('[:]'))
        }, 'null'],

        ['yjs-text: validate_patches accepts yjs-text', () => {
            braid_text.validate_patches([
                {unit: 'yjs-text', range: '(42-5:73-2)', content: 'hello'}
            ])
            return 'ok'
        }, 'ok'],

        ['yjs-text: validate_patches rejects bad range', () => {
            try {
                braid_text.validate_patches([
                    {unit: 'yjs-text', range: 'garbage', content: 'hello'}
                ])
                return 'should have thrown'
            } catch (e) { return 'ok' }
        }, 'ok'],

        // from_yjs_binary tests
        ['from_yjs_binary: insert into empty doc', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'hello')
            var update = Y.encodeStateAsUpdate(doc)
            var patches = braid_text.from_yjs_binary(update)
            doc.destroy()
            if (patches.length !== 1) return 'expected 1 patch, got ' + patches.length
            if (patches[0].unit !== 'yjs-text') return 'wrong unit: ' + patches[0].unit
            if (patches[0].content !== 'hello') return 'wrong content: ' + patches[0].content
            if (patches[0].range !== '(:)') return 'wrong range: ' + patches[0].range
            return 'ok'
        }, 'ok'],

        ['from_yjs_binary: insert with origins', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'helloworld')
            var sv = Y.encodeStateVector(doc)
            var cid = doc.clientID
            doc.getText('text').insert(5, ' ')
            var update = Y.encodeStateAsUpdate(doc, sv)
            var patches = braid_text.from_yjs_binary(update)
            doc.destroy()
            if (patches.length !== 1) return 'expected 1 patch, got ' + patches.length
            if (patches[0].content !== ' ') return 'wrong content: ' + patches[0].content
            // Should have exclusive range with origins referencing clock 4 and clock 5
            var expected = `(${cid}-4:${cid}-5)`
            if (patches[0].range !== expected) return 'wrong range: ' + patches[0].range + ' expected: ' + expected
            return 'ok'
        }, 'ok'],

        ['from_yjs_binary: delete produces inclusive range', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'hello world')
            var cid = doc.clientID
            var sv = Y.encodeStateVector(doc)
            doc.getText('text').delete(5, 6)
            var update = Y.encodeStateAsUpdate(doc, sv)
            var patches = braid_text.from_yjs_binary(update)
            doc.destroy()
            if (patches.length !== 1) return 'expected 1 patch, got ' + patches.length
            if (patches[0].content !== '') return 'expected empty content'
            var expected = '[' + cid + '-5:' + cid + '-10]'
            if (patches[0].range !== expected) return 'wrong range: ' + patches[0].range
            return 'ok'
        }, 'ok'],

        ['from_yjs_binary: delete range format is correct', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'abcde')
            var cid = doc.clientID
            var sv = Y.encodeStateVector(doc)
            doc.getText('text').delete(1, 3)  // delete 'bcd'
            var update = Y.encodeStateAsUpdate(doc, sv)
            var patches = braid_text.from_yjs_binary(update)
            doc.destroy()
            if (patches.length !== 1) return 'expected 1 patch, got ' + patches.length
            if (patches[0].range !== `[${cid}-1:${cid}-3]`) return 'wrong range: ' + patches[0].range
            return 'ok'
        }, 'ok'],

        ['to_yjs_binary: insert applies correctly', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'hello')
            var cid = doc.clientID

            var doc2 = new Y.Doc()
            Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc))

            var binary = braid_text.to_yjs_binary([{
                unit: 'yjs-text',
                range: `(${cid}-4:)`,
                content: ' world',
                id: {client: 999, clock: 0}
            }])
            Y.applyUpdate(doc2, binary)
            var result = doc2.getText('text').toString()
            doc.destroy(); doc2.destroy()
            return result
        }, 'hello world'],

        ['to_yjs_binary: delete applies correctly', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'hello world')
            var cid = doc.clientID

            var doc2 = new Y.Doc()
            Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc))

            var binary = braid_text.to_yjs_binary([{
                unit: 'yjs-text',
                range: `[${cid}-5:${cid}-10]`,
                content: ''
            }])
            Y.applyUpdate(doc2, binary)
            var result = doc2.getText('text').toString()
            doc.destroy(); doc2.destroy()
            return result
        }, 'hello'],

        ['to_yjs_binary: from/to round-trip on synced docs', () => {
            var Y = require('yjs')
            var doc1 = new Y.Doc()
            doc1.getText('text').insert(0, 'hello')
            var doc2 = new Y.Doc()
            Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

            var sv = Y.encodeStateVector(doc1)
            doc1.getText('text').insert(5, ' world')
            var update = Y.encodeStateAsUpdate(doc1, sv)

            // binary -> json -> binary -> apply
            var patches = braid_text.from_yjs_binary(update)
            var decoded = Y.decodeUpdate(update)
            for (var i = 0; i < patches.length; i++) {
                if (patches[i].content.length > 0 && decoded.structs[i])
                    patches[i].id = {client: decoded.structs[i].id.client, clock: decoded.structs[i].id.clock}
            }
            var binary2 = braid_text.to_yjs_binary(patches)
            Y.applyUpdate(doc2, binary2)

            var result = doc2.getText('text').toString()
            doc1.destroy(); doc2.destroy()
            return result
        }, 'hello world'],

        ['from_yjs_binary: no-op returns empty', () => {
            var Y = require('yjs')
            var doc = new Y.Doc()
            doc.getText('text').insert(0, 'hello')
            var update = Y.encodeStateAsUpdate(doc)
            var sv = Y.encodeStateVector(doc)
            var empty_update = Y.encodeStateAsUpdate(doc, sv)
            var patches = braid_text.from_yjs_binary(empty_update)
            doc.destroy()
            return patches.length
        }, 0],

        // Yjs persistence tests
        ['yjs persistence: DT+Yjs round-trip through disk', async () => {
            var key = 'persist-test-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = __dirname + '/test_db_folder'
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            var r = await braid_text.get_resource(key)
            await braid_text.ensure_yjs_exists(r)
            var yjsCid = r.yjs.text._start.id.client
            await braid_text.put(key, {
                patches: [{unit: 'yjs-text', range: '(' + yjsCid + '-0:)', content: 'B', id: {client: 888, clock: 0}}]
            })
            r.dt.doc.free(); r.yjs.doc.destroy(); delete braid_text.cache[key]
            var r2 = await braid_text.get_resource(key)
            var result = r2.val === 'AB' && r2.dt?.doc.get() === 'AB' && r2.yjs?.text.toString() === 'AB'
            await r2.delete()
            return result ? 'ok' : 'mismatch: ' + r2.val
        }, 'ok'],

        ['yjs persistence: Yjs-only round-trip through disk', async () => {
            var key = 'persist-yjs-only-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = __dirname + '/test_db_folder'
            var r = await braid_text.get_resource(key)
            await braid_text.ensure_yjs_exists(r)
            await braid_text.put(key, {
                patches: [{unit: 'yjs-text', range: '(:)', content: 'hello', id: {client: 777, clock: 0}}]
            })
            r.yjs.doc.destroy(); delete braid_text.cache[key]
            var r2 = await braid_text.get_resource(key)
            var result = r2.val === 'hello' && !r2.dt && r2.yjs?.text.toString() === 'hello'
            await r2.delete()
            return result ? 'ok' : 'fail: val=' + r2.val + ' dt=' + !!r2.dt + ' yjs=' + r2.yjs?.text.toString()
        }, 'ok'],

    ]

    for (var [name, fn, expected] of yjs_unit_tests) {
        totalTests++
        try {
            var result = await fn()
            if (result === expected) {
                passedTests++
                console.log(`✓ ${name}`)
            } else {
                failedTests++
                console.log(`✗ ${name}`)
                console.log(`  Expected: ${expected}`)
                console.log(`  Got: ${result}`)
            }
        } catch (e) {
            failedTests++
            console.log(`✗ ${name}`)
            console.log(`  Error: ${e.message}`)
        }
    }

    // Reprint summary with unit tests included
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
    if (failedTests === 0 && !args.includes('fuzz') && !args.includes('all')) {
        console.log(`\nAll tests complete. Consider 'npm test -- fuzz' for all fuzz tests, 'npm test -- fuzz1' for DT fuzz, 'npm test -- fuzz2' for Yjs bridge fuzz, or 'npm test -- all' for everything.`)
    }
    console.log('='.repeat(50))

    // Run fuzz tests if 'all' was requested
    if (args.includes('all') && failedTests === 0) {
        console.log('\nRunning DT fuzz tests...\n')
        try {
            require('child_process').execSync('node test/fuzz-test.js', {
                stdio: 'inherit',
                cwd: path.join(__dirname, '..')
            })
        } catch (e) {
            console.log('DT fuzz tests failed!')
            failedTests++
        }
        console.log('\nRunning Yjs bridge fuzz tests...\n')
        try {
            require('child_process').execSync('node test/yjs-fuzz-test.js', {
                stdio: 'inherit',
                cwd: path.join(__dirname, '..')
            })
        } catch (e) {
            console.log('Yjs bridge fuzz tests failed!')
            failedTests++
        }
    }

    // Clean up test database folder
    console.log('Cleaning up test database folder...')
    const fs = require('fs')
    const path = require('path')
    const testDbPath = path.join(__dirname, 'test_db_folder')
    try {
        if (fs.existsSync(testDbPath)) {
            fs.rmSync(testDbPath, { recursive: true, force: true })
            console.log('Test database folder removed')
        }
    } catch (err) {
        console.log(`Warning: Could not remove test database folder: ${err.message}`)
    }

    const testBackupsPath = path.join(__dirname, 'test_db_folder-backups-test')
    try {
        if (fs.existsSync(testBackupsPath)) {
            fs.rmSync(testBackupsPath, { recursive: true, force: true })
            console.log('Test backups folder removed')
        }
    } catch (err) {
        console.log(`Warning: Could not remove test backups folder: ${err.message}`)
    }

    // Force close the server and all connections
    console.log('Closing server...')
    testServer.server.close(() => {
        console.log('Server closed callback - calling process.exit()')
        process.exit(failedTests > 0 ? 1 : 0)
    })

    // Also close all active connections if the method exists (Node 18.2+)
    if (typeof testServer.server.closeAllConnections === 'function') {
        console.log('Closing all connections...')
        testServer.server.closeAllConnections()
    }

    // Fallback: force exit after a short delay even if server hasn't fully closed
    console.log('Setting 200ms timeout fallback...')
    setTimeout(() => {
        console.log('Timeout reached - calling process.exit()')
        process.exit(failedTests > 0 ? 1 : 0)
    }, 200)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function runBrowserMode() {
    const testServer = createTestServer({
        port,
        runTests: false,
        logRequests: true
    })

    await testServer.start()
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    if (mode === 'browser') {
        await runBrowserMode()
    } else if ((args.includes('fuzz') || args.includes('fuzz1') || args.includes('fuzz2')) && !args.includes('all')) {
        // Fuzz only — skip integration tests
        if (args.includes('fuzz') || args.includes('fuzz1')) {
            console.log('Running DT fuzz tests...\n')
            require('child_process').execSync('node test/fuzz-test.js', {
                stdio: 'inherit',
                cwd: __dirname + '/..'
            })
        }
        if (args.includes('fuzz') || args.includes('fuzz2')) {
            console.log('\nRunning Yjs bridge fuzz tests...\n')
            require('child_process').execSync('node test/yjs-fuzz-test.js', {
                stdio: 'inherit',
                cwd: __dirname + '/..'
            })
        }
    } else {
        await runConsoleTests()
    }
}

// Run the appropriate mode
main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
