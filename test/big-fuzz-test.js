
let Y = require('yjs')
let braid_text = require('../server.js')

braid_text.db_folder = null
braid_text.debug_sync_checks = true
braid_text.simpletonSetTimeout = (fn) => setTimeout(fn, 0)

process.on("unhandledRejection", (x) =>
    console.log(`unhandledRejection: ${x.stack ?? x}`)
)

// ============================================================
// RNG (Mersenne Twister)
// ============================================================

var MersenneTwister = function(seed) {
    if (seed == undefined) seed = new Date().getTime()
    this.N = 624; this.M = 397
    this.MATRIX_A = 0x9908b0df; this.UPPER_MASK = 0x80000000; this.LOWER_MASK = 0x7fffffff
    this.mt = new Array(this.N); this.mti = this.N + 1
    this.init_genrand(seed)
}
MersenneTwister.prototype.init_genrand = function(s) {
    this.mt[0] = s >>> 0
    for (this.mti = 1; this.mti < this.N; this.mti++) {
        var s = this.mt[this.mti-1] ^ (this.mt[this.mti-1] >>> 30)
        this.mt[this.mti] = (((((s & 0xffff0000) >>> 16) * 1812433253) << 16) + (s & 0x0000ffff) * 1812433253) + this.mti
        this.mt[this.mti] >>>= 0
    }
}
MersenneTwister.prototype.genrand_int32 = function() {
    var y, mag01 = [0x0, this.MATRIX_A]
    if (this.mti >= this.N) {
        var kk
        if (this.mti == this.N+1) this.init_genrand(5489)
        for (kk=0;kk<this.N-this.M;kk++) { y=(this.mt[kk]&this.UPPER_MASK)|(this.mt[kk+1]&this.LOWER_MASK); this.mt[kk]=this.mt[kk+this.M]^(y>>>1)^mag01[y&0x1] }
        for (;kk<this.N-1;kk++) { y=(this.mt[kk]&this.UPPER_MASK)|(this.mt[kk+1]&this.LOWER_MASK); this.mt[kk]=this.mt[kk+(this.M-this.N)]^(y>>>1)^mag01[y&0x1] }
        y=(this.mt[this.N-1]&this.UPPER_MASK)|(this.mt[0]&this.LOWER_MASK); this.mt[this.N-1]=this.mt[this.M-1]^(y>>>1)^mag01[y&0x1]
        this.mti = 0
    }
    y = this.mt[this.mti++]
    y ^= (y >>> 11); y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= (y >>> 18)
    return y >>> 0
}
MersenneTwister.prototype.random = function() { return this.genrand_int32() * (1.0/4294967296.0) }

function seed_random(seed) {
    var r = new MersenneTwister(seed)
    Math.random = () => r.random()
}

// ============================================================
// Random text generation
// ============================================================

const CHARS = [
    'A','B','C','D','E','F','G','a','b','c','d','e','f',
    '0','1','2','3',
    'α','β','γ','δ','ε',
    '零','一','二','三',
    '🌈','🌞','🌝',
    'あ','い','う',
]

function random_char() { return CHARS[Math.floor(Math.random() * CHARS.length)] }
function random_string(max_len) {
    return Array(Math.floor(Math.random() * max_len) + 1).fill(0).map(() => random_char()).join('')
}

// ============================================================
// Apply text patches to a codepoint-indexed string
// ============================================================

function apply_text_patches(text, patches) {
    var offset = 0
    for (var p of patches) {
        var range = typeof p.range === 'string'
            ? p.range.match(/-?\d+/g).map(Number)
            : p.range
        var start = range[0] + offset
        var end = range[1] + offset
        var cp = [...text]
        text = cp.slice(0, start).join('') + p.content + cp.slice(end).join('')
        offset += [...p.content].length - (end - start)
    }
    return text
}

// ============================================================
// Make a random edit on a codepoint-indexed string
// Returns {new_text, patches} or null
// ============================================================

function random_edit(text) {
    var cp = [...text]
    if (cp.length === 0) return null
    var pos = Math.floor(Math.random() * (cp.length + 1))
    var del_len = (pos < cp.length && Math.random() < 0.3)
        ? Math.min(Math.floor(Math.random() * 3) + 1, cp.length - pos) : 0
    var content = del_len === 0 ? random_char() : (Math.random() < 0.5 ? random_string(3) : '')
    if (del_len === 0 && content === '') return null
    var new_text = cp.slice(0, pos).join('') + content + cp.slice(pos + del_len).join('')
    return {
        new_text,
        patches: [{unit: 'text', range: `[${pos}:${pos + del_len}]`, content}]
    }
}

// ============================================================
// Fuzz iteration
// ============================================================

async function run_fuzz(seed, num_steps) {
    seed_random(seed)

    var N_SIMPLETON = 2
    var N_DT = 1
    var N_YJS = 2
    var N_TOTAL = N_SIMPLETON + N_DT + N_YJS
    var key = 'fuzz-' + seed
    var vc = 0

    // Create the resource with an initial value
    await braid_text.get_resource(key)
    await braid_text.put(key, {version: ['init-0'], body: 'X'})

    var tick = () => new Promise(r => setTimeout(r, 0))

    // ── Create peers ──
    var peers = []

    // Simpleton peers use the simpleton algorithm:
    // - Only accept updates whose parents match our current version
    // - When dirty (outbox has pending edits), drop incoming updates
    // - The server will resend rebased updates after our PUT is processed
    for (var i = 0; i < N_SIMPLETON; i++) {
        let peer = {
            type: 'simpleton',
            id: 'simpleton-' + i,
            text: null,
            version: null,
            char_counter: -1,
            outbox: [],
        }
        function v_eq(a, b) {
            return a && b && a.length === b.length && a.every((v, i) => v === b[i])
        }
        await braid_text.get(key, {
            merge_type: 'simpleton',
            peer: peer.id,
            subscribe: (update) => {
                // Simpleton invariant: only accept if parents match our version
                if (peer.version && !v_eq(update.parents, peer.version)) return
                if (update.body != null) peer.text = update.body
                if (update.patches) {
                    if (peer.text === null) throw new Error(`${peer.id}: got patches before initial body`)
                    peer.text = apply_text_patches(peer.text, update.patches)
                }
                if (!update.version) throw new Error(`${peer.id}: update missing version`)
                peer.version = update.version
            }
        })
        await tick()
        peers.push(peer)
    }

    // DT peers: maintain a local braid_text resource and feed updates into it.
    // A real DT client merges updates into its own DT doc via braid_text.put().
    for (var i = 0; i < N_DT; i++) {
        let local_key = key + '-dt-' + i
        await braid_text.get_resource(local_key)
        let peer = {
            type: 'dt',
            id: 'dt-' + i,
            local_key: local_key,
            text: null,
            version: null,
            char_counter: -1,
            outbox: [],
        }
        await braid_text.get(key, {
            merge_type: 'dt',
            peer: peer.id,
            subscribe: async (update) => {
                await braid_text.put(local_key, update)
                var lr = await braid_text.get_resource(local_key)
                peer.text = lr.val
                peer.version = lr.version
            }
        })
        await tick()
        peers.push(peer)
    }

    // Yjs peers: subscribe with yjs-text, maintain local Y.Doc
    for (var i = 0; i < N_YJS; i++) {
        let peer = {
            type: 'yjs',
            id: 'yjs-' + i,
            doc: new Y.Doc(),
            text: null,
            outbox: [],
        }
        await braid_text.get(key, {
            range_unit: 'yjs-text',
            peer: peer.id,
            subscribe: (update) => {
                if (!update.patches) throw new Error(`${peer.id}: yjs update missing patches`)
                var binary = braid_text.to_yjs_binary([update])
                if (!binary || binary.length === 0) throw new Error(`${peer.id}: to_yjs_binary returned empty`)
                Y.applyUpdate(peer.doc, binary)
                peer.text = peer.doc.getText('text').toString()
            }
        })
        await tick()
        peers.push(peer)
    }

    // ── Generate edit and push to outbox ──

    function generate_edit(peer) {
        if (peer.type === 'yjs') {
            var t = peer.doc.getText('text')
            var cp = [...t.toString()]
            if (cp.length === 0) return null
            var pos = Math.floor(Math.random() * cp.length)
            var del_len = Math.random() < 0.3
                ? Math.min(Math.floor(Math.random() * 3) + 1, cp.length - pos) : 0
            var content = del_len === 0 ? random_char() : (Math.random() < 0.5 ? random_string(3) : '')
            if (del_len === 0 && content === '') return null

            // Apply locally to Y.Doc
            var utf16_pos = cp.slice(0, pos).join('').length
            var utf16_del = cp.slice(pos, pos + del_len).join('').length
            var sv = Y.encodeStateVector(peer.doc)
            peer.doc.transact(() => {
                if (utf16_del) t.delete(utf16_pos, utf16_del)
                if (content) t.insert(utf16_pos, content)
            })
            var update = Y.encodeStateAsUpdate(peer.doc, sv)
            peer.text = t.toString()

            var yjs_updates = braid_text.from_yjs_binary(update)
            return { version: yjs_updates[0]?.version, patches: yjs_updates[0]?.patches, peer: peer.id }

        } else {
            // Simpleton or DT: use the simpleton algorithm
            var edit = random_edit(peer.text)
            if (!edit) return null

            var change_count = 0
            for (var p of edit.patches) {
                var range = p.range.match(/-?\d+/g).map(Number)
                change_count += (range[1] - range[0]) + [...p.content].length
            }
            peer.char_counter += change_count
            var version = [peer.id + '-' + peer.char_counter]

            // Simpleton algorithm: optimistically advance state and version
            var parents = peer.version
            peer.text = edit.new_text
            peer.version = version

            return {
                version,
                parents,
                patches: edit.patches,
                peer: peer.id
            }
        }
    }

    // ── Send outbox message to server ──

    async function process_outbox(peer) {
        if (peer.outbox.length === 0) return false
        var msg = peer.outbox.shift()
        try {
            // DT peers also feed the edit into their local resource
            if (peer.type === 'dt') {
                await braid_text.put(peer.local_key, msg)
                var lr = await braid_text.get_resource(peer.local_key)
                peer.text = lr.val
                peer.version = lr.version
            }
            await braid_text.put(key, msg)
        } catch(e) {
            // Version conflict or other error
        }
        return true
    }

    // ── Main fuzz loop ──

    for (var step = 0; step < num_steps; step++) {
        var peer = peers[Math.floor(Math.random() * N_TOTAL)]

        if (Math.random() < 0.333) {
            // 1/3 chance: make an edit, push to outbox
            var edit = generate_edit(peer)
            if (edit) peer.outbox.push(edit)
        } else {
            // 2/3 chance: network communication — send an outbox message
            await process_outbox(peer)
            await tick()  // allow broadcast delivery via microtask
        }
    }

    // ── Wind down: drain all outboxes ──

    var progress = true
    while (progress) {
        progress = false
        for (var peer of peers) {
            if (await process_outbox(peer)) {
                await tick()
                progress = true
            }
        }
    }
    await tick()

    // ── Check convergence ──

    var r = await braid_text.get_resource(key)
    var server_text = r.val
    var all_match = true

    for (var peer of peers) {
        if (peer.text !== server_text) {
            console.error(`  CONVERGENCE FAIL: ${peer.id} "${peer.text?.slice(0,50)}" vs server "${server_text.slice(0,50)}"`)
            all_match = false
        }
    }

    // ── Cleanup ──

    for (var peer of peers) {
        if (peer.type === 'yjs') peer.doc.destroy()
        if (peer.type === 'dt') {
            var lr = await braid_text.get_resource(peer.local_key)
            if (lr.dt) lr.dt.doc.free()
            delete braid_text.cache[peer.local_key]
        }
    }
    if (r.dt) r.dt.doc.free()
    if (r.yjs) r.yjs.doc.destroy()
    delete braid_text.cache[key]

    return all_match
}

// ============================================================
// Main
// ============================================================

async function main() {
    var base = Math.floor(Math.random() * 10000000)
    var num_iterations = 5000
    var steps_per_iteration = 250
    var failures = 0

    console.log(`Yjs bridge fuzz test: ${num_iterations} iterations, ${steps_per_iteration} steps each`)
    console.log(`  Peers: 2 simpleton + 1 dt + 2 yjs`)

    for (var t = 0; t < num_iterations; t++) {
        var seed = base + t
        try {
            var ok = await run_fuzz(seed, steps_per_iteration)
            if (!ok) {
                console.log(`  FAIL seed=${seed}`)
                failures++
            } else if (t % 20 === 0) {
                console.log(`  t=${t} seed=${seed} ok`)
            }
        } catch(e) {
            console.log(`  ERROR seed=${seed}: ${e.message}`)
            failures++
        }
    }

    console.log(`\nDone: ${num_iterations - failures}/${num_iterations} passed`)
    console.log(`Run individually with: npm test -- fuzz2`)
    if (failures) {
        console.log(`${failures} failures`)
        process.exit(1)
    }
}

main()
