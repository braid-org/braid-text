
let Y = require('yjs')
let braid_text = require('../server.js')

braid_text.db_folder = null
braid_text.debug_sync_checks = true

process.on("unhandledRejection", (x) =>
    console.log(`unhandledRejection: ${x.stack ?? x}`)
)

// ============================================================
// RNG (Mersenne Twister from fuzz-test.js)
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
// Fuzz iteration
// ============================================================

async function run_fuzz(seed, num_steps) {
    seed_random(seed)

    var N_BRAID = 3
    var N_YJS = 3
    var key = 'fuzz-' + seed

    var r = await braid_text.get_resource(key)
    await braid_text.ensure_dt_exists(r)
    await braid_text.ensure_yjs_exists(r)
    await braid_text.put(key, {version: ['init-0'], body: 'X'})

    // Braid peers: each has local text and version, may be behind
    var braid_peers = Array.from({length: N_BRAID}, (_, i) => ({
        text: r.val,
        version: [...r.version],
    }))

    // Yjs peers: each has a Y.Doc, may be behind
    var yjs_peers = Array.from({length: N_YJS}, (_, i) => {
        var doc = new Y.Doc()
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(r.yjs.doc))
        return { doc }
    })

    var vc = 0

    for (var step = 0; step < num_steps; step++) {
        var choice = Math.floor(Math.random() * (N_BRAID + N_YJS))

        if (choice < N_BRAID) {
            // Braid peer edit
            var bp = braid_peers[choice]

            // Sometimes sync to server first (66% chance)
            if (Math.random() < 0.66) {
                bp.text = r.val
                bp.version = [...r.version]
            }

            var cp = [...bp.text]
            if (cp.length === 0) continue
            var pos = Math.floor(Math.random() * (cp.length + 1))
            var del_len = (pos < cp.length && Math.random() < 0.3)
                ? Math.min(Math.floor(Math.random() * 3) + 1, cp.length - pos) : 0
            var content = del_len === 0 ? random_char() : (Math.random() < 0.5 ? random_string(3) : '')
            if (del_len === 0 && content === '') continue

            var change_count = [...content].length + del_len
            var v = `braid-${choice}-${vc}`
            vc += change_count

            // Apply locally
            bp.text = cp.slice(0, pos).join('') + content + cp.slice(pos + del_len).join('')

            try {
                await braid_text.put(key, {
                    version: [v],
                    parents: bp.version,
                    patches: [{unit: 'text', range: `[${pos}:${pos + del_len}]`, content}],
                    peer: 'braid-' + choice
                })
                bp.version = [v]
                // Sync back
                bp.text = r.val
                bp.version = [...r.version]
            } catch(e) {
                // Version conflict — resync
                bp.text = r.val
                bp.version = [...r.version]
                continue
            }
        } else {
            // Yjs peer edit
            var yp = yjs_peers[choice - N_BRAID]

            // Sometimes sync to server first (66% chance)
            if (Math.random() < 0.66) {
                Y.applyUpdate(yp.doc, Y.encodeStateAsUpdate(r.yjs.doc, Y.encodeStateVector(yp.doc)))
            }

            var t = yp.doc.getText('text')
            var cp = [...t.toString()]
            if (cp.length === 0) continue
            var pos = Math.floor(Math.random() * cp.length)
            var del_len = Math.random() < 0.3
                ? Math.min(Math.floor(Math.random() * 3) + 1, cp.length - pos) : 0
            var content = del_len === 0 ? random_char() : (Math.random() < 0.5 ? random_string(3) : '')
            if (del_len === 0 && content === '') continue

            var utf16_pos = cp.slice(0, pos).join('').length
            var utf16_del = cp.slice(pos, pos + del_len).join('').length

            var sv = Y.encodeStateVector(r.yjs.doc)
            yp.doc.transact(() => {
                if (utf16_del) t.delete(utf16_pos, utf16_del)
                if (content) t.insert(utf16_pos, content)
            })
            var update = Y.encodeStateAsUpdate(yp.doc, sv)

            await braid_text.put(key, {yjs_update: update, peer: 'yjs-' + (choice - N_BRAID)})

            // Sync back
            Y.applyUpdate(yp.doc, Y.encodeStateAsUpdate(r.yjs.doc, Y.encodeStateVector(yp.doc)))
        }

        // Server sanity check
        var dt_t = r.dt.doc.get()
        var yjs_t = r.yjs.text.toString()
        if (dt_t !== yjs_t) {
            throw new Error(`SYNC MISMATCH at step ${step}: DT="${dt_t.slice(0,50)}" Yjs="${yjs_t.slice(0,50)}"`)
        }
        if (r.val !== dt_t) {
            throw new Error(`VAL MISMATCH at step ${step}: val="${r.val.slice(0,50)}" DT="${dt_t.slice(0,50)}"`)
        }
    }

    // Final convergence: sync all peers
    for (var bp of braid_peers) { bp.text = r.val; bp.version = [...r.version] }
    for (var yp of yjs_peers) {
        Y.applyUpdate(yp.doc, Y.encodeStateAsUpdate(r.yjs.doc, Y.encodeStateVector(yp.doc)))
    }

    var server_text = r.val
    var all_match = true
    for (var i = 0; i < braid_peers.length; i++) {
        if (braid_peers[i].text !== server_text) {
            console.error(`  CONVERGENCE FAIL: braid-${i} "${braid_peers[i].text.slice(0,30)}" vs server "${server_text.slice(0,30)}"`)
            all_match = false
        }
    }
    for (var i = 0; i < yjs_peers.length; i++) {
        var yt = yjs_peers[i].doc.getText('text').toString()
        if (yt !== server_text) {
            console.error(`  CONVERGENCE FAIL: yjs-${i} "${yt.slice(0,30)}" vs server "${server_text.slice(0,30)}"`)
            all_match = false
        }
    }

    // Cleanup
    for (var yp of yjs_peers) yp.doc.destroy()
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
