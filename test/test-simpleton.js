#!/usr/bin/env node

// Simpleton client test suite: deterministic tests + fuzz session.

const http = require('http')
const fs = require('fs')
const path = require('path')
const {fetch: braid_fetch} = require('braid-http')

// Load simpleton_client by evaluating the source (it has no module.exports)
const simpleton_src = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'simpleton-sync.js'), 'utf8')
const simpleton_client = new Function('braid_fetch', 'crypto',
    simpleton_src + '\nreturn simpleton_client;')(braid_fetch, require('crypto').webcrypto)

const PORT = 9877

// ── Helpers ─────────────────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function truncate(str, len) {
    if (str.length <= len) return str
    return str.slice(0, len - 1) + '…'
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

function wait_for(fn, interval = 20) {
    return new Promise(resolve => {
        let check = setInterval(() => {
            if (fn()) { clearInterval(check); resolve() }
        }, interval)
    })
}

// ── Shared server ───────────────────────────────────────────────────────
let braid_text
let server
let delay_peer = null
let delayed_responses = []

async function start_server() {
    braid_text = require(path.join(__dirname, '..', 'server.js'))
    braid_text.db_folder = null

    server = http.createServer(async (req, res) => {
        braid_text.free_cors(res)
        if (req.method === 'OPTIONS') return

        if (delay_peer && req.method === 'PUT' && req.headers['peer'] === delay_peer) {
            let orig_end = res.end.bind(res)
            let orig_writeHead = res.writeHead.bind(res)
            let saved_args = null
            res.end = (...args) => {
                delayed_responses.push(() => {
                    if (saved_args) orig_writeHead(...saved_args)
                    orig_end(...args)
                })
            }
            res.writeHead = (...args) => { saved_args = args }
        }

        braid_text.serve(req, res)
    })

    await new Promise(resolve => server.listen(PORT, 'localhost', resolve))
}

function release_delayed() {
    delay_peer = null
    for (let fn of delayed_responses) fn()
    delayed_responses.length = 0
}

// ── Simpleton client helper ─────────────────────────────────────────────
function make_client(url, label) {
    let doc = ''
    let online = false
    let sc = null

    function start() {
        sc = simpleton_client(url, {
            get_state: () => doc,
            on_state: (state) => { doc = state },
            on_error: (e) => {
                if (e?.name === 'AbortError' || e?.message?.includes('abort')) return
            },
            on_online: (is_online) => { online = is_online },
        })
    }

    function stop() {
        if (sc) { sc.abort(); sc = null }
        online = false
    }

    start()
    return {
        label,
        start, stop,
        get state() { return doc },
        set state(v) { doc = v },
        get online() { return online },
        changed() { sc.changed() },
    }
}

// ========================================================================
// Deterministic Tests
// ========================================================================

async function test_throttle_staleness() {
    // Tests that when a client is throttled and receives multiple updates,
    // all are queued and applied in order when the client unthrottles.
    // Previously throttled_update was a single value and the second update
    // would be rejected, leaving the client stuck behind.

    const key = '/test-throttle-' + Math.random().toString(36).slice(2)
    const url = `http://localhost:${PORT}${key}`

    const a = make_client(url, 'A')
    await wait_for(() => a.online)

    const resource = await braid_text.get_resource(key)
    delay_peer = [...resource.simpleton.clients][0].peer

    const b = make_client(url, 'B')
    await wait_for(() => b.online)

    // A makes 11 rapid edits (10 PUTs go out, 11th is throttled)
    for (let i = 0; i < 11; i++) {
        a.state = a.state + String.fromCharCode(97 + i)
        a.changed()
    }

    // Wait for PUTs to reach server and B to receive them
    await wait(1000)

    // B makes 2 changes
    b.state = 'X' + b.state
    b.changed()
    await wait(500)

    b.state = 'Y' + b.state
    b.changed()
    await wait(500)

    // A undoes 11th edit and calls changed() to unthrottle.
    // This applies throttled_update (B's 1st change) but B's 2nd was rejected.
    a.state = a.state.replace('k', '')
    a.changed()
    await wait(500)

    // Release A's delayed PUT responses
    release_delayed()
    await wait(2000)

    const server_state = await braid_text.get(key)
    const stuck = server_state !== a.state

    a.stop()
    b.stop()

    return { stuck, a_state: a.state, b_state: b.state, server_state }
}

async function test_emoji_surrogate_pairs() {
    // Regression test: simple_diff was splitting surrogate pairs when adjacent
    // emoji share the same high surrogate (e.g. U+1F389 and U+1F38A both have
    // high surrogate 0xD83C). The prefix scan would match the high surrogate
    // and stop on the low surrogate, producing a diff range that starts in
    // the middle of a codepoint.

    const key = '/test-emoji-' + Math.random().toString(36).slice(2)
    const url = `http://localhost:${PORT}${key}`

    const a = make_client(url, 'A')
    const b = make_client(url, 'B')
    await wait_for(() => a.online && b.online)

    // Set initial state with same-block emoji (all have high surrogate 0xD83C)
    a.state = '\uD83C\uDF89\uD83C\uDF8A\uD83C\uDF88'  // 🎉🎊🎈
    a.changed()
    await wait(800)

    if (b.state !== '\uD83C\uDF89\uD83C\uDF8A\uD83C\uDF88') {
        a.stop(); b.stop()
        return { ok: false, reason: 'initial sync failed', a: a.state, b: b.state }
    }

    // B deletes the middle emoji (🎊). Its local state becomes 🎉🎈.
    // simple_diff compares old='🎉🎊🎈' vs new='🎉🎈'. Without the fix,
    // the prefix scan matches 3 code units (high surrogates of 🎊 and 🎈
    // are both 0xD83C), producing the wrong diff.
    b.state = '\uD83C\uDF89\uD83C\uDF88'  // 🎉🎈
    b.changed()
    await wait(800)

    const server_state = await braid_text.get(key)
    const ok = a.state === '\uD83C\uDF89\uD83C\uDF88' &&
               b.state === '\uD83C\uDF89\uD83C\uDF88' &&
               server_state === '\uD83C\uDF89\uD83C\uDF88'

    a.stop()
    b.stop()
    return { ok, a_state: a.state, b_state: b.state, server_state }
}

// ========================================================================
// Fuzz Session
// ========================================================================

const FUZZ_CLIENTS = 5
const FUZZ_DURATION_MS = 10000
const FUZZ_EDIT_INTERVAL = [5, 50]
const FUZZ_OFFLINE_CHANCE = 0.06
const FUZZ_OFFLINE_DURATION = [100, 500]
const FUZZ_SETTLE_MS = 6000
const CHARS = 'abcdefghij'

async function run_fuzz() {
    const key = '/fuzz-' + Math.random().toString(36).slice(2)
    const url = `http://localhost:${PORT}${key}`

    const clients = []
    for (let i = 0; i < FUZZ_CLIENTS; i++) {
        clients.push(make_client(url, `c${i}`))
    }

    process.stdout.write('  Waiting for clients...')
    await wait_for(() => clients.every(c => c.online))
    console.log(' done.\n')

    let edit_count = 0, offline_count = 0
    const start_time = Date.now()

    const status_timer = setInterval(() => {
        let elapsed = ((Date.now() - start_time) / 1000).toFixed(1)
        let parts = clients.map(c => {
            let status = c.online ? `${c.state.length}ch` : 'OFF'
            return `${c.label}:${status}`
        })
        let line = `  [${elapsed}s] ${edit_count} edits | ${parts.join('  ')} | "${truncate(clients[0].state, 40)}"`
        process.stdout.write('\r' + line + '  ')
    }, 500)

    await new Promise(resolve => {
        const timers = clients.map((client, i) => {
            function schedule() {
                let delay = rand(FUZZ_EDIT_INTERVAL[0], FUZZ_EDIT_INTERVAL[1])
                return setTimeout(() => {
                    if (Date.now() - start_time >= FUZZ_DURATION_MS) return

                    if (client.online && Math.random() < FUZZ_OFFLINE_CHANCE) {
                        offline_count++
                        client.stop()
                        setTimeout(() => {
                            if (Date.now() - start_time < FUZZ_DURATION_MS)
                                client.start()
                        }, rand(FUZZ_OFFLINE_DURATION[0], FUZZ_OFFLINE_DURATION[1]))
                    } else if (client.online) {
                        let len = client.state.length
                        let op = len === 0 ? 'insert' : (['insert', 'insert', 'delete'][rand(0, 2)])
                        if (op === 'insert') {
                            let pos = rand(0, len)
                            let text = ''
                            for (let j = 0; j < rand(1, 3); j++)
                                text += CHARS[rand(0, CHARS.length - 1)]
                            client.state = client.state.slice(0, pos) + text + client.state.slice(pos)
                        } else {
                            let pos = rand(0, len - 1)
                            let del_len = rand(1, Math.min(3, len - pos))
                            client.state = client.state.slice(0, pos) + client.state.slice(pos + del_len)
                        }
                        client.changed()
                        edit_count++
                    }
                    timers[i] = schedule()
                }, delay)
            }
            return schedule()
        })

        setTimeout(() => {
            timers.forEach(t => clearTimeout(t))
            resolve()
        }, FUZZ_DURATION_MS)
    })

    clearInterval(status_timer)
    console.log(`\n\n  Fuzz done: ${edit_count} edits, ${offline_count} offline events`)

    for (let c of clients) {
        if (!c.online) c.start()
    }

    console.log(`  Waiting ${FUZZ_SETTLE_MS / 1000}s for convergence...\n`)
    await wait(FUZZ_SETTLE_MS)

    const server_state = await braid_text.get(key)

    console.log('  === Final states ===')
    console.log(`  server:   "${truncate(server_state || '', 60)}" (${server_state?.length} chars)`)
    let all_match = true
    for (let c of clients) {
        let match = c.state === server_state
        if (!match) all_match = false
        console.log(`  ${c.label}: "${truncate(c.state, 60)}" (${c.state.length} chars) ${match ? '✓' : '✗ MISMATCH'}`)
    }

    for (let c of clients) c.stop()
    return all_match
}

// ========================================================================
// Main
// ========================================================================

async function main() {
    await start_server()
    console.log(`Server on port ${PORT}\n`)

    let failed = 0

    // ── Deterministic tests ─────────────────────────────────────────
    console.log('=== Test: throttle with queued updates ===')
    let result = await test_throttle_staleness()
    if (!result.stuck) {
        console.log(`  ✓ A caught up (throttled updates applied in order)`)
    } else {
        console.log(`  ✗ A is stuck behind — throttled updates were lost`)
        console.log(`    A: "${result.a_state}", server: "${result.server_state}"`)
        failed++
    }

    console.log('\n=== Test: emoji surrogate pair handling ===')
    let emoji_result = await test_emoji_surrogate_pairs()
    if (emoji_result.ok) {
        console.log(`  ✓ Correct emoji deleted across clients`)
    } else {
        console.log(`  ✗ Wrong emoji deleted (surrogate pair split)`)
        console.log(`    A: "${emoji_result.a_state}", B: "${emoji_result.b_state}", server: "${emoji_result.server_state}"`)
        if (emoji_result.reason) console.log(`    Reason: ${emoji_result.reason}`)
        failed++
    }

    // ── Fuzz session ────────────────────────────────────────────────
    console.log('\n=== Fuzz: 5 simpleton clients, 10s ===')
    let fuzz_ok = await run_fuzz()
    if (fuzz_ok) {
        console.log('\n  ✓ ALL CLIENTS CONVERGED')
    } else {
        console.log('\n  ✗ CONVERGENCE FAILURE')
        failed++
    }

    // ── Done ────────────────────────────────────────────────────────
    console.log()
    server.close()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 200)
}

main().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
})
