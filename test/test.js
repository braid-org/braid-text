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

    const braid_text = require(`${__dirname}/../index.js`)
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
    for (const { testName, testFunction, expectedResult } of testsToRun) {
        try {
            const result = await testFunction()
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
    console.log('='.repeat(50))

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
    } else {
        await runConsoleTests()
    }
}

// Run the appropriate mode
main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
