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

        // Always returns 404
        if (req.url === '/404') {
            res.statusCode = 404
            return res.end('Not Found')
        }

        // Returns 404 on the first subscribe GET, then serves normally.
        // URL: /404-once/<key>
        if (req.url.startsWith('/404-once/')) {
            var key = req.url.slice('/404-once'.length)
            if (!test_server._404_subs) test_server._404_subs = {}
            if (req.method === 'GET' && req.headers.subscribe) {
                if (!test_server._404_subs[key]) {
                    test_server._404_subs[key] = true
                    res.statusCode = 404
                    return res.end('Not Found')
                }
            }
            return braid_text.serve(req, res, {key})
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

            if (parts[1] === 'dt_create_bytes_big_name') {
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
                version: '999-0'
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
        // Test that both DT and Yjs state survive cache eviction and disk reload.
        // Uses yjs_update (raw binary) to create Yjs content, which avoids the
        // origin mismatch issues of yjs-text patches.
        ['yjs persistence: DT+Yjs round-trip through disk', async () => {
            var Y = require('yjs')
            var key = 'persist-test-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = __dirname + '/test_db_folder'
            // Create DT with initial text
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            // Create a Yjs update that inserts 'B' and apply it
            var tmp = new Y.Doc()
            tmp.getText('text').insert(0, 'AB')
            var update = Y.encodeStateAsUpdate(tmp)
            tmp.destroy()
            await braid_text.put(key, {yjs_update: update})
            // Evict from cache
            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            // Reload and verify
            var r2 = await braid_text.get_resource(key)
            var dt_ok = r2.dt?.doc.get()
            var yjs_ok = r2.yjs?.text.toString()
            await r2.delete()
            return (dt_ok === yjs_ok && dt_ok?.length > 0) ? 'ok' : 'mismatch: dt=' + dt_ok + ' yjs=' + yjs_ok
        }, 'ok'],

        // ── yjs-text .get() subscribe tests ──

        // Subscribe to DT-only resource: should create Yjs on demand and
        // serve history as real yjs-text patches
        ['yjs-text subscribe: DT-only resource', async () => {
            var Y = require('yjs')
            var key = 'yjsget-dt-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-4'], body: 'hello'})
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            // Should get history patches
            var all_patches = updates.flatMap(u => u.patches || [])
            if (all_patches.length === 0) return 'no patches received'
            // Root insert should have (:) range
            if (all_patches[0].range !== '(:)') return 'root range: ' + all_patches[0].range
            if (all_patches[0].content !== 'hello') return 'root content: ' + all_patches[0].content
            // Should have a real version (clientID-clock)
            if (!/^\d+-\d+$/.test(all_patches[0].version)) return 'bad version: ' + all_patches[0].version
            // Round-trip: apply to fresh Y.Doc
            var doc = new Y.Doc()
            var binary = braid_text.to_yjs_binary(all_patches)
            Y.applyUpdate(doc, binary)
            var text = doc.getText('text').toString()
            doc.destroy()
            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'hello' ? 'ok' : 'text=' + text
        }, 'ok'],

        // Subscribe to Yjs-only resource
        ['yjs-text subscribe: Yjs-only resource', async () => {
            var Y = require('yjs')
            var key = 'yjsget-yjs-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {
                patches: [{unit: 'yjs-text', range: '(:)', content: 'world', version: '555-0'}]
            })
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            var all_patches = updates.flatMap(u => u.patches || [])
            if (all_patches.length === 0) return 'no patches'
            var doc = new Y.Doc()
            Y.applyUpdate(doc, braid_text.to_yjs_binary(all_patches))
            var text = doc.getText('text').toString()
            doc.destroy()
            var r = await braid_text.get_resource(key)
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'world' ? 'ok' : 'text=' + text
        }, 'ok'],

        // Subscribe to resource with both DT and Yjs
        ['yjs-text subscribe: DT+Yjs resource', async () => {
            var Y = require('yjs')
            var key = 'yjsget-both-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            // Make a Yjs edit that inserts 'B' after syncing with server's Y.Doc
            var r = await braid_text.get_resource(key)
            await braid_text.get(key, {range_unit: 'yjs-text', parents: r.version, subscribe: () => {}})
            var tmp = new Y.Doc()
            Y.applyUpdate(tmp, Y.encodeStateAsUpdate(r.yjs.doc))
            tmp.getText('text').insert(1, 'B')
            var update = Y.encodeStateAsUpdate(tmp, Y.encodeStateVector(r.yjs.doc))
            tmp.destroy()
            await braid_text.put(key, {yjs_update: update})
            // Now subscribe fresh and verify history
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            var all_patches = updates.flatMap(u => u.patches || [])
            if (all_patches.length === 0) return 'no patches'
            var doc = new Y.Doc()
            Y.applyUpdate(doc, braid_text.to_yjs_binary(all_patches))
            var text = doc.getText('text').toString()
            doc.destroy()
            r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'AB' ? 'ok' : 'text=' + text
        }, 'ok'],

        // Live update: DT edit arrives to yjs-text subscriber
        ['yjs-text subscribe: live update from DT edit', async () => {
            var Y = require('yjs')
            var key = 'yjsget-live-dt-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            // Apply initial history to a Y.Doc
            var doc = new Y.Doc()
            var init_patches = updates.flatMap(u => u.patches || [])
            if (init_patches.length) Y.applyUpdate(doc, braid_text.to_yjs_binary(init_patches))
            // Now make a DT edit
            updates.length = 0
            await braid_text.put(key, {
                version: ['b-0'], parents: ['a-0'],
                patches: [{unit: 'text', range: '[1:1]', content: 'B'}]
            })
            // Should have received a live update
            var live_patches = updates.flatMap(u => u.patches || [])
            if (live_patches.length === 0) return 'no live patches'
            Y.applyUpdate(doc, braid_text.to_yjs_binary(live_patches))
            var text = doc.getText('text').toString()
            doc.destroy()
            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'AB' ? 'ok' : 'text=' + text
        }, 'ok'],

        // Live update: Yjs edit arrives to yjs-text subscriber
        ['yjs-text subscribe: live update from Yjs edit', async () => {
            var Y = require('yjs')
            var key = 'yjsget-live-yjs-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                peer: 'reader',
                subscribe: (u) => updates.push(u)
            })
            var doc = new Y.Doc()
            var init_patches = updates.flatMap(u => u.patches || [])
            if (init_patches.length) Y.applyUpdate(doc, braid_text.to_yjs_binary(init_patches))
            // Make a Yjs edit from a different peer
            updates.length = 0
            var tmp = new Y.Doc()
            var r = await braid_text.get_resource(key)
            Y.applyUpdate(tmp, Y.encodeStateAsUpdate(r.yjs.doc))
            tmp.getText('text').insert(1, 'B')
            var yjs_update = Y.encodeStateAsUpdate(tmp, Y.encodeStateVector(r.yjs.doc))
            tmp.destroy()
            await braid_text.put(key, {yjs_update, peer: 'writer'})
            // Should have received a live update
            var live_patches = updates.flatMap(u => u.patches || [])
            if (live_patches.length === 0) return 'no live patches'
            Y.applyUpdate(doc, braid_text.to_yjs_binary(live_patches))
            var text = doc.getText('text').toString()
            doc.destroy()
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'AB' ? 'ok' : 'text=' + text
        }, 'ok'],

        // Subscribe with current parents: no history, only live updates
        ['yjs-text subscribe: current parents skips history', async () => {
            var key = 'yjsget-skip-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-4'], body: 'hello'})
            var r = await braid_text.get_resource(key)
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                parents: r.version,
                subscribe: (u) => updates.push(u)
            })
            var all_patches = updates.flatMap(u => u.patches || [])
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return all_patches.length === 0 ? 'ok' : 'got ' + all_patches.length + ' patches'
        }, 'ok'],

        // Empty resource: subscribe gets no patches
        ['yjs-text subscribe: empty resource', async () => {
            var key = 'yjsget-empty-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.get_resource(key)
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            var all_patches = updates.flatMap(u => u.patches || [])
            var r = await braid_text.get_resource(key)
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return all_patches.length === 0 ? 'ok' : 'got ' + all_patches.length + ' patches'
        }, 'ok'],

        // Multiple edits: history covers all of them
        ['yjs-text subscribe: multiple edits in history', async () => {
            var Y = require('yjs')
            var key = 'yjsget-multi-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-0'], body: 'A'})
            await braid_text.put(key, {
                version: ['b-0'], parents: ['a-0'],
                patches: [{unit: 'text', range: '[1:1]', content: 'B'}]
            })
            await braid_text.put(key, {
                version: ['c-0'], parents: ['b-0'],
                patches: [{unit: 'text', range: '[2:2]', content: 'C'}]
            })
            var updates = []
            await braid_text.get(key, {
                range_unit: 'yjs-text',
                subscribe: (u) => updates.push(u)
            })
            var all_patches = updates.flatMap(u => u.patches || [])
            var doc = new Y.Doc()
            Y.applyUpdate(doc, braid_text.to_yjs_binary(all_patches))
            var text = doc.getText('text').toString()
            doc.destroy()
            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return text === 'ABC' ? 'ok' : 'text=' + text
        }, 'ok'],

        // ── subscribe-when-already-current tests ──

        ['simpleton subscribe with current parents gets no history', async () => {
            var key = 'simp-current-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-4'], body: 'hello'})
            var r = await braid_text.get_resource(key)
            var updates = []
            await braid_text.get(key, {
                merge_type: 'simpleton',
                parents: r.version,
                subscribe: u => updates.push(u)
            })
            await new Promise(r => setTimeout(r, 0))
            // Should get no initial updates — already current
            if (updates.length > 0) return 'got ' + updates.length + ' updates'
            // But a subsequent edit should arrive
            await braid_text.put(key, {
                version: ['b-0'], parents: r.version,
                patches: [{unit: 'text', range: '[5:5]', content: '!'}]
            })
            await new Promise(r => setTimeout(r, 0))
            r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return updates.length === 1 ? 'ok' : 'expected 1 update, got ' + updates.length
        }, 'ok'],

        ['dt subscribe with current parents gets no history', async () => {
            var key = 'dt-current-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['a-4'], body: 'hello'})
            var r = await braid_text.get_resource(key)
            var updates = []
            await braid_text.get(key, {
                merge_type: 'dt',
                parents: r.version,
                subscribe: u => updates.push(u)
            })
            await new Promise(r => setTimeout(r, 0))
            if (updates.length > 0) return 'got ' + updates.length + ' updates'
            await braid_text.put(key, {
                version: ['b-0'], parents: r.version,
                patches: [{unit: 'text', range: '[5:5]', content: '!'}]
            })
            await new Promise(r => setTimeout(r, 0))
            r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return updates.length === 1 ? 'ok' : 'expected 1 update, got ' + updates.length
        }, 'ok'],

        // ── convergence tests: multiple peers via subscribe ──

        ['convergence: simpleton receives other peer edits', async () => {
            var Y = require('yjs')
            var key = 'conv-simp-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-1'], body: 'AB'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            // Subscribe two simpletons
            var s1 = {inbox: [], text: null, version: null}
            var s2 = {inbox: [], text: null, version: null}
            await braid_text.get(key, {merge_type: 'simpleton', peer: 'p1', subscribe: u => s1.inbox.push(u)})
            await braid_text.get(key, {merge_type: 'simpleton', peer: 'p2', subscribe: u => s2.inbox.push(u)})
            await tick()

            // Drain initial
            for (var u of s1.inbox) { if (u.body != null) s1.text = u.body; if (u.version) s1.version = u.version }
            for (var u of s2.inbox) { if (u.body != null) s2.text = u.body; if (u.version) s2.version = u.version }
            s1.inbox = []; s2.inbox = []

            // s1 inserts 'X' at position 1
            await braid_text.put(key, {
                version: ['p1-0'], parents: s1.version,
                patches: [{unit: 'text', range: '[1:1]', content: 'X'}],
                peer: 'p1'
            })
            s1.text = 'AXB'
            s1.version = ['p1-0']
            await tick()

            // s2 should receive the update
            for (var u of s2.inbox) {
                if (u.patches) s2.text = apply_patches(s2.text, u.patches)
                if (u.version) s2.version = u.version
            }
            s2.inbox = []

            var r = await braid_text.get_resource(key)
            if (s1.text !== r.val) return 's1=' + s1.text + ' server=' + r.val
            if (s2.text !== r.val) return 's2=' + s2.text + ' server=' + r.val
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return 'ok'
        }, 'ok'],

        ['convergence: simpleton + yjs peer both edit', async () => {
            var Y = require('yjs')
            var key = 'conv-mixed-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-1'], body: 'AB'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            // Subscribe simpleton and yjs peer
            var simp = {inbox: [], text: null, version: null}
            var yjs = {inbox: [], doc: new Y.Doc()}
            await braid_text.get(key, {merge_type: 'simpleton', peer: 'simp', subscribe: u => simp.inbox.push(u)})
            await braid_text.get(key, {range_unit: 'yjs-text', peer: 'yjs', subscribe: u => yjs.inbox.push(u)})
            await tick()

            // Drain initial
            for (var u of simp.inbox) { if (u.body != null) simp.text = u.body; if (u.version) simp.version = u.version }
            for (var u of yjs.inbox) { if (u.patches) Y.applyUpdate(yjs.doc, braid_text.to_yjs_binary(u.patches)) }
            simp.inbox = []; yjs.inbox = []

            // Simpleton inserts 'X' at position 1
            await braid_text.put(key, {
                version: ['simp-0'], parents: simp.version,
                patches: [{unit: 'text', range: '[1:1]', content: 'X'}],
                peer: 'simp'
            })
            simp.text = 'AXB'
            simp.version = ['simp-0']
            await tick()

            // Yjs peer should receive the update
            for (var u of yjs.inbox) {
                if (u.patches) Y.applyUpdate(yjs.doc, braid_text.to_yjs_binary(u.patches))
            }
            yjs.inbox = []

            // Now yjs peer inserts 'Y' at position 0
            var t = yjs.doc.getText('text')
            var sv = Y.encodeStateVector(yjs.doc)
            t.insert(0, 'Y')
            var update = Y.encodeStateAsUpdate(yjs.doc, sv)
            var patches = braid_text.from_yjs_binary(update)
            await braid_text.put(key, {patches, peer: 'yjs'})
            await tick()

            // Simpleton should receive the yjs edit
            for (var u of simp.inbox) {
                if (u.patches) simp.text = apply_patches(simp.text, u.patches)
                if (u.version) simp.version = u.version
            }
            simp.inbox = []

            var r = await braid_text.get_resource(key)
            var yjs_text = yjs.doc.getText('text').toString()
            var results = []
            if (simp.text !== r.val) results.push('simp=' + simp.text + ' server=' + r.val)
            if (yjs_text !== r.val) results.push('yjs=' + yjs_text + ' server=' + r.val)
            yjs.doc.destroy()
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return results.length ? results.join('; ') : 'ok'
        }, 'ok'],

        ['convergence: two simpletons alternate edits', async () => {
            var key = 'conv-alt-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-0'], body: 'X'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            var s1 = {text: null, version: null, cc: -1}
            var s2 = {text: null, version: null, cc: -1}
            await braid_text.get(key, {
                merge_type: 'simpleton', peer: 'p1',
                subscribe: u => {
                    if (u.body != null) s1.text = u.body
                    if (u.patches) s1.text = apply_patches(s1.text || '', u.patches)
                    if (u.version) s1.version = u.version
                }
            })
            await braid_text.get(key, {
                merge_type: 'simpleton', peer: 'p2',
                subscribe: u => {
                    if (u.body != null) s2.text = u.body
                    if (u.patches) s2.text = apply_patches(s2.text || '', u.patches)
                    if (u.version) s2.version = u.version
                }
            })
            await tick()

            // Step 1: s1 inserts 'A' at end
            s1.cc += 1
            var parents1 = s1.version
            s1.text = s1.text + 'A'
            s1.version = ['p1-' + s1.cc]
            await braid_text.put(key, {
                version: ['p1-' + s1.cc], parents: parents1,
                patches: [{unit: 'text', range: '[1:1]', content: 'A'}],
                peer: 'p1'
            })
            await tick()

            // Step 2: s2 inserts 'B' at end
            s2.cc += 1
            var parents2 = s2.version
            s2.text = s2.text + 'B'
            s2.version = ['p2-' + s2.cc]
            await braid_text.put(key, {
                version: ['p2-' + s2.cc], parents: parents2,
                patches: [{unit: 'text', range: '[2:2]', content: 'B'}],
                peer: 'p2'
            })
            await tick()

            // Step 3: s1 inserts 'C' at end
            s1.cc += 1
            var parents3 = s1.version
            s1.text = s1.text + 'C'
            s1.version = ['p1-' + s1.cc]
            await braid_text.put(key, {
                version: ['p1-' + s1.cc], parents: parents3,
                patches: [{unit: 'text', range: '[3:3]', content: 'C'}],
                peer: 'p1'
            })
            await tick()

            var r = await braid_text.get_resource(key)
            var result = `server=${r.val} s1=${s1.text} s2=${s2.text}`
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return s1.text === r.val && s2.text === r.val
                ? 'ok' : result
        }, 'ok'],

        ['convergence: simpleton + yjs concurrent edits via outbox', async () => {
            var Y = require('yjs')
            var key = 'conv-conc-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-0'], body: 'X'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            // Simpleton
            var simp = {text: null, version: null, cc: -1}
            await braid_text.get(key, {
                merge_type: 'simpleton', peer: 'simp',
                subscribe: u => {
                    if (u.body != null) simp.text = u.body
                    if (u.patches) simp.text = apply_patches(simp.text || '', u.patches)
                    if (u.version) simp.version = u.version
                }
            })
            await tick()

            // Yjs
            var ydoc = new Y.Doc()
            await braid_text.get(key, {
                range_unit: 'yjs-text', peer: 'yjs',
                subscribe: u => {
                    if (u.patches) {
                        var bin = braid_text.to_yjs_binary(u.patches)
                        if (bin && bin.length > 0) Y.applyUpdate(ydoc, bin)
                    }
                }
            })
            await tick()

            // Both make edits simultaneously (outbox model)
            // Simpleton inserts 'A' at position 0
            simp.cc += 1
            var simp_msg = {
                version: ['simp-' + simp.cc], parents: simp.version,
                patches: [{unit: 'text', range: '[0:0]', content: 'A'}],
                peer: 'simp'
            }
            simp.text = 'A' + simp.text
            simp.version = ['simp-' + simp.cc]

            // Yjs inserts 'B' at end
            var t = ydoc.getText('text')
            var sv = Y.encodeStateVector(ydoc)
            t.insert(t.toString().length, 'B')
            var yjs_msg = {
                patches: braid_text.from_yjs_binary(Y.encodeStateAsUpdate(ydoc, sv)),
                peer: 'yjs'
            }

            // Send simpleton's edit first
            await braid_text.put(key, simp_msg)
            await tick()

            // Send yjs edit
            await braid_text.put(key, yjs_msg)
            await tick()

            var r = await braid_text.get_resource(key)
            var yjs_text = ydoc.getText('text').toString()
            var results = []
            if (simp.text !== r.val) results.push('simp=' + simp.text + ' server=' + r.val)
            if (yjs_text !== r.val) results.push('yjs=' + yjs_text + ' server=' + r.val)
            ydoc.destroy()
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return results.length ? results.join('; ') : 'ok'
        }, 'ok'],

        ['convergence: simpleton queues two edits then sends both', async () => {
            var key = 'conv-queue-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-0'], body: 'X'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            var simp = {text: null, version: null, cc: -1}
            await braid_text.get(key, {
                merge_type: 'simpleton', peer: 'simp',
                subscribe: u => {
                    if (u.body != null) simp.text = u.body
                    if (u.patches) simp.text = apply_patches(simp.text || '', u.patches)
                    if (u.version) simp.version = u.version
                }
            })
            await tick()
            // simp.text = 'X', simp.version = ['init-0']

            // Edit 1: insert 'A' at end (simpleton algorithm: advance optimistically)
            simp.cc += 1
            var msg1 = {
                version: ['simp-' + simp.cc], parents: simp.version,
                patches: [{unit: 'text', range: '[1:1]', content: 'A'}],
                peer: 'simp'
            }
            simp.text = 'XA'
            simp.version = ['simp-' + simp.cc]

            // Edit 2: insert 'B' at end (before sending edit 1!)
            simp.cc += 1
            var msg2 = {
                version: ['simp-' + simp.cc], parents: simp.version,
                patches: [{unit: 'text', range: '[2:2]', content: 'B'}],
                peer: 'simp'
            }
            simp.text = 'XAB'
            simp.version = ['simp-' + simp.cc]

            // Now send both
            await braid_text.put(key, msg1)
            await tick()
            await braid_text.put(key, msg2)
            await tick()

            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return simp.text === r.val ? 'ok' : 'simp=' + simp.text + ' server=' + r.val
        }, 'ok'],

        ['convergence: simpleton sends edit, receives external, sends another', async () => {
            var key = 'conv-inter-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = null
            await braid_text.put(key, {version: ['init-0'], body: 'X'})
            var tick = () => new Promise(r => setTimeout(r, 0))

            function apply_patches(text, patches) {
                var offset = 0
                for (var p of patches) {
                    var range = p.range.match(/-?\d+/g).map(Number)
                    var cp = [...text]
                    text = cp.slice(0, range[0]+offset).join('') + p.content + cp.slice(range[1]+offset).join('')
                    offset += [...p.content].length - (range[1] - range[0])
                }
                return text
            }

            var simp = {text: null, version: null, cc: -1}
            await braid_text.get(key, {
                merge_type: 'simpleton', peer: 'simp',
                subscribe: u => {
                    if (u.body != null) simp.text = u.body
                    if (u.patches) simp.text = apply_patches(simp.text || '', u.patches)
                    if (u.version) simp.version = u.version
                }
            })
            await tick()

            // Simpleton edits: insert 'A' at end
            simp.cc += 1
            await braid_text.put(key, {
                version: ['simp-' + simp.cc], parents: simp.version,
                patches: [{unit: 'text', range: '[1:1]', content: 'A'}],
                peer: 'simp'
            })
            simp.text = simp.text + 'A'
            simp.version = ['simp-' + simp.cc]
            await tick()

            // External edit: someone inserts 'Z' at position 0
            await braid_text.put(key, {
                version: ['ext-0'], parents: ['simp-0'],
                patches: [{unit: 'text', range: '[0:0]', content: 'Z'}],
                peer: 'external'
            })
            await tick()
            // simp should have received 'Z' inserted

            // Simpleton edits again: insert 'B' at end
            simp.cc += 1
            await braid_text.put(key, {
                version: ['simp-' + simp.cc], parents: simp.version,
                patches: [{unit: 'text', range: '[' + [...simp.text].length + ':' + [...simp.text].length + ']', content: 'B'}],
                peer: 'simp'
            })
            simp.text = simp.text + 'B'
            simp.version = ['simp-' + simp.cc]
            await tick()

            var r = await braid_text.get_resource(key)
            if (r.dt) r.dt.doc.free()
            if (r.yjs) r.yjs.doc.destroy()
            delete braid_text.cache[key]
            return simp.text === r.val ? 'ok' : 'simp=' + simp.text + ' server=' + r.val
        }, 'ok'],


        ['yjs persistence: Yjs-only round-trip through disk', async () => {
            var key = 'persist-yjs-only-' + Math.random().toString(36).slice(2)
            braid_text.db_folder = __dirname + '/test_db_folder'
            var r = await braid_text.get_resource(key)
            await braid_text.put(key, {
                patches: [{unit: 'yjs-text', range: '(:)', content: 'hello', version: '777-0'}]
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
