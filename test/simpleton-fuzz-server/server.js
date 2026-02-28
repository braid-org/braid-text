var braid_text = require("../../server.js")
var { http_server: braidify } = require("braid-http")
var http2 = require("http2")
var fs = require("fs")
var path = require("path")

// Config
var port = process.argv[2] || 4920
var min_delay = parseInt(process.argv[3]) || 500
var max_delay = parseInt(process.argv[4]) || 2000
var edit_interval_min = parseInt(process.argv[5]) || 50
var edit_interval_max = parseInt(process.argv[6]) || 500
var session_duration = 15000     // ms before session ends
var settle_delay = 3000          // ms to wait after last ACK before verifying
var connect_min = 2000           // min connected duration ms (0 = no disconnects)
var connect_max = 8000           // max connected duration ms
var disconnect_min = 2000        // min disconnect duration ms
var disconnect_max = 8000        // max disconnect duration ms
var put_drop_prob = 0.2          // probability (0-1) of dropping a PUT entirely (not processed, connection destroyed)
var ack_drop_prob = 0.2          // probability (0-1) of processing a PUT but dropping the ACK (connection destroyed after processing)

braid_text.db_folder = null

// Generate self-signed cert on the fly
var { execSync } = require("child_process")
var cert_dir = path.join(__dirname, ".certs")
var key_path = path.join(cert_dir, "key.pem")
var cert_path = path.join(cert_dir, "cert.pem")
if (!fs.existsSync(cert_dir)) fs.mkdirSync(cert_dir)
if (!fs.existsSync(key_path)) {
    console.log("generating self-signed cert...")
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${key_path} -out ${cert_path} -days 365 -nodes -subj "/CN=localhost"`, { stdio: "ignore" })
}

// ── Session state ───────────────────────────────────────────────────────
var sessions = []            // active fuzz-session subscribers
var result_subscribers = []  // dashboard subscribers to /fuzz-results
var config_subscribers = []  // dashboard subscribers to /config
var result_history = []      // past results for replaying to new dashboard subscribers
var server_alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
var client_alphabet = "abcdefghijklmnopqrstuvwxyz"

// Each session object: { res, peer, doc_key, fuzz_timer, session_end_timer,
//   settling, settle_timer, start_time, pending_acks, running,
//   disconnected, disconnect_timer }

var server = http2.createSecureServer({
    key: fs.readFileSync(key_path),
    cert: fs.readFileSync(cert_path),
    allowHTTP1: true
}, async (req, res) => {
  try {
    console.log(`${req.method} ${req.url}`)

    braid_text.free_cors(res)
    if (req.method === "OPTIONS") return res.end()

    // Serve the index page
    if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        fs.createReadStream(__dirname + "/index.html").pipe(res)
        return
    }

    // Serve the test client page
    if (req.url === "/test" || req.url === "/test.html") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        fs.createReadStream(__dirname + "/test.html").pipe(res)
        return
    }

    // Serve local client files for the test client
    if (req.url === "/simpleton-sync.js" || req.url === "/web-utils.js") {
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" })
        fs.createReadStream(path.join(__dirname, "../../client" + req.url)).pipe(res)
        return
    }
    if (req.url === "/braid-http-client.js") {
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" })
        fs.createReadStream(path.join(__dirname, "../../node_modules/braid-http/braid-http-client.js")).pipe(res)
        return
    }

    // Config endpoint
    if (req.url === "/config") {
        if (req.method === "POST") {
            var body = ""
            req.on("data", d => body += d)
            req.on("end", () => {
                try {
                    var cfg = JSON.parse(body)
                    if (cfg.min_delay != null) min_delay = cfg.min_delay
                    if (cfg.max_delay != null) max_delay = cfg.max_delay
                    if (cfg.edit_interval_min != null) edit_interval_min = cfg.edit_interval_min
                    if (cfg.edit_interval_max != null) edit_interval_max = cfg.edit_interval_max
                    if (cfg.session_duration != null) session_duration = cfg.session_duration
                    if (cfg.settle_delay != null) settle_delay = cfg.settle_delay
                    var restart_disconnects = false
                    if (cfg.connect_min != null) { connect_min = cfg.connect_min; restart_disconnects = true }
                    if (cfg.connect_max != null) { connect_max = cfg.connect_max; restart_disconnects = true }
                    if (cfg.disconnect_min != null) { disconnect_min = cfg.disconnect_min; restart_disconnects = true }
                    if (cfg.disconnect_max != null) { disconnect_max = cfg.disconnect_max; restart_disconnects = true }
                    if (restart_disconnects) sessions.forEach(s => restart_disconnect_scheduler(s))
                    if (cfg.put_drop_prob != null) put_drop_prob = cfg.put_drop_prob
                    if (cfg.ack_drop_prob != null) ack_drop_prob = cfg.ack_drop_prob
                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(config_json())
                } catch (e) {
                    res.writeHead(400)
                    res.end(e.message)
                }
            })
            return
        }
        braidify(req, res)
        if (req.subscribe) {
            var sub = { res }
            config_subscribers.push(sub)
            res.startSubscription({
                onClose: () => {
                    config_subscribers = config_subscribers.filter(s => s !== sub)
                }
            })
            // Send initial state
            res.sendUpdate({ body: config_json() })
            return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(config_json())
        return
    }

    // ── Fuzz session command channel ─────────────────────────────────────
    if (req.url === "/fuzz-session") {
        if (req.method === "GET") {
            braidify(req, res)
            if (!req.subscribe) {
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ sessions: sessions.length }))
                return
            }

            // Start subscription — this is a new test client joining
            var peer = req.headers["peer"] || ("anon-" + Math.random().toString(36).slice(2, 8))
            var doc_key = "/fuzz-doc-" + peer
            var session = {
                res, peer, doc_key,
                fuzz_timer: null, session_end_timer: null,
                settling: false, settle_timer: null, settle_start_time: null,
                start_time: null, pending_acks: 0, running: false,
                disconnected: false, disconnect_timer: null,
                doc_sub_res: null,
                pending_ack_flushers: []
            }
            sessions.push(session)
            res.startSubscription({
                onClose: () => {
                    stop_session(session)
                    sessions = sessions.filter(s => s !== session)
                    console.log(`session disconnected: ${peer} (${sessions.length} remaining)`)
                }
            })
            console.log(`session connected: ${peer}, doc: ${doc_key} (${sessions.length} total)`)

            // Tell the client which doc to subscribe to
            res.sendUpdate({
                body: JSON.stringify({ type: "start", peer, doc_key })
            })

            // Auto-start this session's fuzz
            start_session(session)
            return
        }

        if (req.method === "POST") {
            // Client uploading its state for verification
            var body = ""
            req.on("data", d => body += d)
            req.on("end", async () => {
                try {
                    var msg = JSON.parse(body)
                    if (msg.type === "state") {
                        var session = sessions.find(s => s.peer === msg.peer)
                        var doc_key = session ? session.doc_key : "/fuzz-doc-" + msg.peer
                        var server_state = await braid_text.get(doc_key) || ""
                        var match = msg.state === server_state
                        var result = {
                            type: "result",
                            peer: msg.peer,
                            match,
                            server_state,
                            client_state: msg.state,
                            time: new Date().toISOString()
                        }
                        console.log(`VERIFY ${msg.peer}: ${match ? "PASS" : "FAIL"}`)
                        if (!match) {
                            console.log(`  server (${server_state.length} chars): ${JSON.stringify(server_state.slice(0, 200))}`)
                            console.log(`  client (${msg.state.length} chars): ${JSON.stringify(msg.state.slice(0, 200))}`)
                        }

                        // Send result back to this specific client's session
                        if (session) {
                            session.res.sendUpdate({
                                body: JSON.stringify(result)
                            })
                        }

                        // Broadcast to dashboard result subscribers
                        broadcast_result(result)

                        res.writeHead(200, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ ok: true, match }))
                    } else {
                        res.writeHead(400)
                        res.end("unknown message type")
                    }
                } catch (e) {
                    res.writeHead(400)
                    res.end(e.message)
                }
            })
            return
        }

        res.writeHead(405)
        res.end()
        return
    }

    // ── Fuzz results subscription (for dashboard) ────────────────────────
    if (req.url === "/fuzz-results") {
        braidify(req, res)
        if (req.method === "GET" && req.subscribe) {
            var sub = { res }
            result_subscribers.push(sub)
            res.startSubscription({
                onClose: () => {
                    result_subscribers = result_subscribers.filter(s => s !== sub)
                }
            })
            // Replay past results
            for (var r of result_history) {
                try { res.sendUpdate({ body: JSON.stringify(r) }) }
                catch (e) { break }
            }
            return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end("[]")
        return
    }

    // Simulate per-session disconnect: drop requests for disconnected sessions
    var disc_session = sessions.find(s => s.doc_key === req.url && s.disconnected)
    if (disc_session) {
        console.log(`  (simulated disconnect for ${disc_session.peer} -- dropping ${req.method} ${req.url})`)
        req.on("data", () => {})
        req.on("end", () => res.destroy())
        return
    }

    // For PUTs: process immediately but delay the HTTP response.
    // Track pending ACKs per session (matched by doc URL).
    if (req.method === "PUT") {
        var put_session = sessions.find(s => s.doc_key === req.url)

        // PUT drop: drop the entire request (don't process, destroy connection)
        // Disabled during settling so verification can complete.
        if (put_session && !put_session.settling && put_drop_prob > 0 && Math.random() < put_drop_prob) {
            console.log(`  (simulated PUT drop for ${put_session.peer} -- dropping PUT ${req.url})`)
            req.on("data", () => {})
            req.on("end", () => res.destroy())
            return
        }

        if (put_session) put_session.pending_acks++
        var orig_writeHead = res.writeHead.bind(res)
        var orig_end = res.end.bind(res)
        var buffered_writeHead_args = null
        var flushed = false
        res.writeHead = function (...args) {
            buffered_writeHead_args = args
        }
        res.end = function (...end_args) {
            // ACK drop: process the PUT but destroy connection instead of responding.
            // Disabled during settling so verification can complete.
            if (put_session && !put_session.settling && ack_drop_prob > 0 && Math.random() < ack_drop_prob) {
                console.log(`  (simulated ACK drop for ${put_session.peer} -- PUT processed but ACK dropped)`)
                put_session.pending_acks--
                res.destroy()
                return
            }

            function do_flush() {
                if (flushed) return
                flushed = true
                if (put_session) put_session.pending_ack_flushers = put_session.pending_ack_flushers.filter(f => f !== do_flush)
                clearTimeout(delay_timer)
                if (buffered_writeHead_args) orig_writeHead(...buffered_writeHead_args)
                orig_end(...end_args)
                if (put_session) {
                    put_session.pending_acks--
                    check_settle(put_session)
                }
            }
            var ms = (put_session && put_session.settling) ? 0 : min_delay + Math.floor(Math.random() * (max_delay - min_delay))
            var delay_timer = setTimeout(do_flush, ms)
            if (put_session) put_session.pending_ack_flushers.push(do_flush)
        }
    }

    // Track doc subscription response so we can destroy it on simulated disconnect
    var sub_session = sessions.find(s => s.doc_key === req.url)
    if (sub_session && req.method === "GET" && req.headers.subscribe) {
        sub_session.doc_sub_res = res
        // If session was waiting to settle until client reconnected, start settling now
        if (sub_session.settling && !sub_session.settle_timer) {
            console.log(`  ${sub_session.peer} reconnected, now settling...`)
            check_settle(sub_session)
        }
    }

    await braid_text.serve(req, res)
  } catch (e) {
    console.log(`request error (${req.method} ${req.url}): ${e.message}`)
    try { if (!res.headersSent) { res.writeHead(500); res.end() } } catch (_) {}
  }
})

// ── Per-session fuzzing ──────────────────────────────────────────────────

async function do_remote_edit(session) {
    var current = await braid_text.get(session.doc_key)
    if (current == null) return

    var chars = [...current]
    var len = chars.length

    // Pick operation: insert, delete, or replace (delete/replace only if doc non-empty)
    var roll = Math.random()
    if (len === 0 || roll < 0.5) {
        // Insert
        var pos = Math.floor(Math.random() * (len + 1))
        var char = server_alphabet[Math.floor(Math.random() * server_alphabet.length)]
        await braid_text.put(session.doc_key, {
            patches: [{ unit: "text", range: `[${pos}:${pos}]`, content: char }]
        })
        console.log(`fuzz: remote insert "${char}" at ${pos} for ${session.peer}`)
    } else if (roll < 0.75) {
        // Delete (1-3 chars)
        var pos = Math.floor(Math.random() * len)
        var del_len = Math.min(1 + Math.floor(Math.random() * 3), len - pos)
        await braid_text.put(session.doc_key, {
            patches: [{ unit: "text", range: `[${pos}:${pos + del_len}]`, content: "" }]
        })
        console.log(`fuzz: remote delete [${pos}:${pos + del_len}] for ${session.peer}`)
    } else {
        // Replace (1-3 chars with a new char)
        var pos = Math.floor(Math.random() * len)
        var rep_len = Math.min(1 + Math.floor(Math.random() * 3), len - pos)
        var char = server_alphabet[Math.floor(Math.random() * server_alphabet.length)]
        await braid_text.put(session.doc_key, {
            patches: [{ unit: "text", range: `[${pos}:${pos + rep_len}]`, content: char }]
        })
        console.log(`fuzz: remote replace [${pos}:${pos + rep_len}] with "${char}" for ${session.peer}`)
    }
}

function do_local_edit_command(session) {
    // range and content are clamped client-side to actual text length
    var pos = Math.floor(Math.random() * 100)
    var roll = Math.random()
    var cmd
    if (roll < 0.5) {
        // Insert
        var char = client_alphabet[Math.floor(Math.random() * client_alphabet.length)]
        cmd = { type: "edit", range: [pos, pos], content: char }
    } else if (roll < 0.75) {
        // Delete
        var del_count = 1 + Math.floor(Math.random() * 3)
        cmd = { type: "edit", range: [pos, pos + del_count], content: "" }
    } else {
        // Replace
        var del_count = 1 + Math.floor(Math.random() * 3)
        var char = client_alphabet[Math.floor(Math.random() * client_alphabet.length)]
        cmd = { type: "edit", range: [pos, pos + del_count], content: char }
    }
    try {
        session.res.sendUpdate({ body: JSON.stringify(cmd) })
    } catch (e) {
        console.log(`failed to send edit to ${session.peer}: ${e.message}`)
    }
    console.log(`fuzz: local edit [${cmd.range}] "${cmd.content}" to ${session.peer}`)
}

async function do_fuzz_tick(session) {
    if (Math.random() < 0.5) {
        await do_remote_edit(session)
    } else {
        do_local_edit_command(session)
    }
}

// ── Session lifecycle (per-session) ──────────────────────────────────────

function start_session(session) {
    if (session.fuzz_timer) return
    session.settling = false
    session.start_time = Date.now()
    session.running = true
    console.log(`\n=== SESSION STARTED for ${session.peer} (duration: ${session_duration}ms) ===`)

    // Start per-session disconnect scheduler
    if (connect_min > 0 || connect_max > 0) restart_disconnect_scheduler(session)

    // Start the fuzz timer for this session
    schedule_next_fuzz(session)

    // Schedule session end
    session.session_end_timer = setTimeout(() => {
        console.log(`=== SESSION DURATION EXPIRED for ${session.peer}, settling... ===`)
        stop_fuzzing(session)
        session.running = false
        session.settling = true
        // Stop disconnect cycling and ensure connected state so client can settle
        if (session.disconnect_timer) { clearTimeout(session.disconnect_timer); session.disconnect_timer = null }
        session.disconnected = false
        // Flush all pending ACK delays immediately — session is over
        var flushers = session.pending_ack_flushers.slice()
        for (var f of flushers) f()
        // Only start settling if client is connected (has an active doc subscription)
        if (session.doc_sub_res) {
            check_settle(session)
        } else {
            console.log(`  waiting for ${session.peer} to reconnect before settling...`)
        }
    }, session_duration)
}

function stop_session(session) {
    stop_fuzzing(session)
    session.settling = false
    session.settle_start_time = null
    session.running = false
    session.start_time = null
    session.disconnected = false
    if (session.session_end_timer) { clearTimeout(session.session_end_timer); session.session_end_timer = null }
    if (session.settle_timer) { clearTimeout(session.settle_timer); session.settle_timer = null }
    if (session.disconnect_timer) { clearTimeout(session.disconnect_timer); session.disconnect_timer = null }
    console.log(`=== SESSION STOPPED for ${session.peer} ===`)
}

function schedule_next_fuzz(session) {
    session.fuzz_timer = setTimeout(async () => {
        try { await do_fuzz_tick(session) }
        catch (e) { console.log(`fuzz tick error for ${session.peer}: ${e.message}`) }
        if (session.fuzz_timer) schedule_next_fuzz(session)
    }, edit_interval_min + Math.floor(Math.random() * (edit_interval_max - edit_interval_min + 1)))
}

function stop_fuzzing(session) {
    if (!session.fuzz_timer) return
    clearTimeout(session.fuzz_timer)
    session.fuzz_timer = null
    console.log(`fuzzing stopped for ${session.peer}`)
}

// ── Settling (per-session) ───────────────────────────────────────────────

function check_settle(session) {
    if (!session.settling) return
    if (session.pending_acks > 0) {
        if (session.settle_timer) { clearTimeout(session.settle_timer); session.settle_timer = null }
        session.settle_start_time = null
        return
    }
    // (Re)start the settle timer — resets if client sends a PUT during settling
    if (session.settle_timer) clearTimeout(session.settle_timer)
    session.settle_start_time = Date.now()
    session.settle_timer = setTimeout(() => {
        session.settle_timer = null
        session.settle_start_time = null
        if (session.pending_acks > 0) return
        request_state_upload(session)
    }, settle_delay)
    console.log(`  settle timer (re)started for ${session.peer} (${settle_delay}ms)`)
}

function request_state_upload(session) {
    session.settling = false
    console.log(`=== REQUESTING STATE UPLOAD from ${session.peer} ===`)
    try {
        session.res.sendUpdate({
            body: JSON.stringify({ type: "upload-state" })
        })
    } catch (e) {
        console.log(`failed to request state from ${session.peer}: ${e.message}`)
    }
}

function broadcast_result(result) {
    result_history.push(result)
    for (var sub of result_subscribers) {
        try {
            sub.res.sendUpdate({
                body: JSON.stringify(result)
            })
        } catch (e) {
            console.log(`failed to broadcast result: ${e.message}`)
        }
    }
}

function broadcast_config() {
    var json = config_json()
    for (var sub of config_subscribers) {
        try { sub.res.sendUpdate({ body: json }) }
        catch (e) {}
    }
}

// Push config/session state updates to dashboard subscribers
setInterval(broadcast_config, 250)

function config_json() {
    return JSON.stringify({
        min_delay, max_delay, edit_interval_min, edit_interval_max, session_duration, settle_delay,
        connect_min, connect_max, disconnect_min, disconnect_max, put_drop_prob, ack_drop_prob,
        sessions: sessions.length,
        session_details: sessions.map(s => ({
            peer: s.peer,
            running: s.running,
            settling: s.settling,
            start_time: s.start_time,
            settle_start_time: s.settle_start_time,
            pending_acks: s.pending_acks,
            disconnected: s.disconnected
        }))
    })
}

// ── Per-session disconnect simulation ────────────────────────────────────

function restart_disconnect_scheduler(session) {
    if (session.disconnect_timer) { clearTimeout(session.disconnect_timer); session.disconnect_timer = null }
    session.disconnected = false
    if (connect_min <= 0 && connect_max <= 0) return  // disabled
    schedule_next_disconnect(session)
}

function schedule_next_disconnect(session) {
    if (connect_min <= 0 && connect_max <= 0) return
    // Stay connected for connect_min–connect_max, then disconnect for disconnect_min–disconnect_max
    var connected_for = connect_min + Math.floor(Math.random() * (connect_max - connect_min))
    session.disconnect_timer = setTimeout(() => {
        session.disconnected = true
        // Destroy existing doc subscription so client detects the disconnect
        if (session.doc_sub_res) {
            try { session.doc_sub_res.destroy() } catch (e) {}
            session.doc_sub_res = null
        }
        var disconnected_for = disconnect_min + Math.floor(Math.random() * (disconnect_max - disconnect_min))
        console.log(`simulated disconnect for ${session.peer} for ${disconnected_for}ms (was connected ${connected_for}ms)`)
        session.disconnect_timer = setTimeout(() => {
            session.disconnected = false
            console.log(`simulated reconnect for ${session.peer}`)
            schedule_next_disconnect(session)
        }, disconnected_for)
    }, connected_for)
}

server.listen(port, async () => {
    console.log(`fuzz server on https://localhost:${port}`)
    console.log(`  dashboard:    https://localhost:${port}/`)
    console.log(`  test client:  https://localhost:${port}/test`)
    console.log(`  documents:    /fuzz-doc-{peer} (created per session)`)
    console.log(`  PUT ACK delay:    ${min_delay}-${max_delay}ms`)
    console.log(`  edit interval:    ${edit_interval_min}-${edit_interval_max}ms`)
    console.log(`  session duration: ${session_duration}ms`)
    console.log(`  settle delay:     ${settle_delay}ms`)
    console.log(`  connect duration: ${connect_min}-${connect_max}ms`)
    console.log(`  disconnect dur:   ${disconnect_min}-${disconnect_max}ms`)
    console.log(`  PUT drop prob:    ${put_drop_prob}`)
    console.log(`  ACK drop prob:    ${ack_drop_prob}`)
    console.log(`  (HTTP/2 with self-signed cert -- accept the cert warning in browser)`)
})
