#!/usr/bin/env node

// Fuzz test for simpleton clients
// Spins up a server, connects N simpleton clients, has them randomly edit
// and go offline/online, then checks they all converge.

const http = require('http')
const fs = require('fs')
const path = require('path')
const {fetch: braid_fetch} = require('braid-http')

// Load simpleton_client by evaluating the source (it has no module.exports)
const simpleton_src = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'simpleton-sync.js'), 'utf8')

const simpleton_client = new Function('braid_fetch', 'crypto',
    simpleton_src + '\nreturn simpleton_client;')(braid_fetch, require('crypto').webcrypto)

// ── Config ──────────────────────────────────────────────────────────────
const NUM_CLIENTS = 5
const FUZZ_DURATION_MS = 10000
const EDIT_INTERVAL_MS = [5, 50]       // rapid edits to create contention
const OFFLINE_CHANCE = 0.06            // chance per edit cycle to go offline
const OFFLINE_DURATION_MS = [100, 500] // how long to stay offline
const SETTLE_TIME_MS = 6000            // time to wait for convergence
const PORT = 9877
const CHARS = 'abcdefghij'
const STATUS_INTERVAL_MS = 500         // how often to print live status

// ── Helpers ─────────────────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function randChar() { return CHARS[rand(0, CHARS.length - 1)] }
function truncate(str, len) {
    if (str.length <= len) return str
    return str.slice(0, len - 1) + '…'
}

// ── Server setup ────────────────────────────────────────────────────────
async function main() {
    const braid_text = require(path.join(__dirname, '..', 'server.js'))
    braid_text.db_folder = null // in-memory only

    const key = '/fuzz-' + Math.random().toString(36).slice(2)
    const url = `http://localhost:${PORT}${key}`

    const server = http.createServer(async (req, res) => {
        braid_text.free_cors(res)
        if (req.method === 'OPTIONS') return
        braid_text.serve(req, res)
    })

    await new Promise(resolve => server.listen(PORT, 'localhost', resolve))
    console.log(`Server listening on port ${PORT}`)
    console.log(`Fuzzing ${NUM_CLIENTS} simpleton clients for ${FUZZ_DURATION_MS / 1000}s...\n`)

    // ── Client state ────────────────────────────────────────────────────
    // Each client has a "local doc" string that it edits, simulating a textarea
    const clients = []

    function create_client(id) {
        let local_doc = ''
        let online = false
        let sc = null
        let error_count = 0

        function start() {
            sc = simpleton_client(url, {
                get_state: () => local_doc,
                on_state: (state) => { local_doc = state },
                on_error: (e) => {
                    // Ignore abort errors from going offline
                    if (e?.name === 'AbortError' || e?.message?.includes('abort')) return
                    error_count++
                    if (error_count <= 3) console.log(`  [client ${id}] error: ${e.message || e}`)
                },
                on_online: (is_online) => { online = is_online },
            })
        }

        function stop() {
            if (sc) { sc.abort(); sc = null }
            online = false
        }

        function do_random_edit() {
            if (!sc) return
            let len = local_doc.length
            let op = len === 0 ? 'insert' : (['insert', 'insert', 'delete'][rand(0, 2)])

            if (op === 'insert') {
                let pos = rand(0, len)
                let text = ''
                for (let i = 0; i < rand(1, 3); i++) text += randChar()
                local_doc = local_doc.slice(0, pos) + text + local_doc.slice(pos)
            } else {
                let pos = rand(0, len - 1)
                let del_len = rand(1, Math.min(3, len - pos))
                local_doc = local_doc.slice(0, pos) + local_doc.slice(pos + del_len)
            }
            sc.changed()
        }

        start()
        return { id, start, stop, do_random_edit,
                 get state() { return local_doc },
                 get online() { return online },
                 get errors() { return error_count } }
    }

    // Create clients
    for (let i = 0; i < NUM_CLIENTS; i++) {
        clients.push(create_client(i))
    }

    // Wait for all clients to come online
    process.stdout.write('Waiting for clients to connect...')
    await new Promise(resolve => {
        let check = setInterval(() => {
            if (clients.every(c => c.online)) {
                clearInterval(check)
                resolve()
            }
        }, 50)
    })
    console.log(' done.\n')

    // ── Fuzz loop ───────────────────────────────────────────────────────
    let edit_count = 0
    let offline_count = 0
    const start_time = Date.now()

    // Live status printer
    const status_timer = setInterval(() => {
        let elapsed = ((Date.now() - start_time) / 1000).toFixed(1)
        let parts = clients.map(c => {
            let status = c.online ? `${c.state.length}ch` : 'OFF'
            return `c${c.id}:${status}`
        })
        let line = `  [${elapsed}s] ${edit_count} edits | ${parts.join('  ')} | "${truncate(clients[0].state, 40)}"`
        process.stdout.write('\r' + line + '  ')
    }, STATUS_INTERVAL_MS)

    await new Promise(resolve => {
        // Each client gets its own edit timer with random intervals
        const timers = clients.map(client => {
            function schedule() {
                let delay = rand(EDIT_INTERVAL_MS[0], EDIT_INTERVAL_MS[1])
                return setTimeout(() => {
                    if (Date.now() - start_time >= FUZZ_DURATION_MS) return

                    // Random offline/online toggling
                    if (client.online && Math.random() < OFFLINE_CHANCE) {
                        offline_count++
                        client.stop()
                        let offline_time = rand(OFFLINE_DURATION_MS[0], OFFLINE_DURATION_MS[1])
                        setTimeout(() => {
                            if (Date.now() - start_time < FUZZ_DURATION_MS) {
                                client.start()
                            }
                        }, offline_time)
                    } else if (client.online) {
                        client.do_random_edit()
                        edit_count++
                    }

                    timers[client.id] = schedule()
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
    console.log(`\n\nFuzz phase done: ${edit_count} edits, ${offline_count} offline events`)

    // Make sure all clients are back online
    for (let c of clients) {
        if (!c.online) {
            c.start()
        }
    }

    // ── Settle and converge ─────────────────────────────────────────────
    console.log(`Waiting ${SETTLE_TIME_MS / 1000}s for convergence...\n`)
    await new Promise(r => setTimeout(r, SETTLE_TIME_MS))

    // ── Check results ───────────────────────────────────────────────────
    const server_state = await braid_text.get(key)
    const states = clients.map(c => c.state)

    console.log('=== Final states ===')
    console.log(`  server:   "${truncate(server_state || '', 60)}" (${server_state?.length} chars)`)
    for (let c of clients) {
        let match = c.state === server_state
        console.log(`  client ${c.id}: "${truncate(c.state, 60)}" (${c.state.length} chars) ${match ? '✓' : '✗ MISMATCH'}`)
    }

    // ── Errors ──────────────────────────────────────────────────────────
    let total_errors = clients.reduce((a, c) => a + c.errors, 0)
    if (total_errors > 0) console.log(`\n  ${total_errors} client errors during fuzz`)

    // ── Verdict ─────────────────────────────────────────────────────────
    let all_match = states.every(s => s === server_state)
    console.log(all_match ? '\n✓ ALL CLIENTS CONVERGED' : '\n✗ CONVERGENCE FAILURE')

    // ── Cleanup ─────────────────────────────────────────────────────────
    for (let c of clients) c.stop()
    server.close()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    setTimeout(() => process.exit(all_match ? 0 : 1), 200)
}

main().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
})
