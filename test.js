
let { Doc } = require("diamond-types-node")
let {dt_get, dt_get_patches, dt_parse, dt_create_bytes} = require('./index.js')

async function main() {
    let best_seed = 0
    let best_n = Infinity
    let base = Math.floor(Math.random() * 10000000)

    let og_log = console.log
    console.log = () => {}
    for (let t = 0; t < 50000; t++) {
        let seed = base + t
    // for (let t = 0; t < 1; t++) {
    //     let seed = 7271846

        og_log(`t = ${t}, seed = ${seed}, best_n = ${best_n} @ ${best_seed}`)
        Math.randomSeed(seed)

        let n = Math.floor(Math.random() * 15)
        console.log(`n = ${n}`)

        try {
            // 1. create a bunch of edits to a dt
            let doc = new Doc('server')

            for (let i = 0; i < n; i++) {
                make_random_edit(doc)
            }

            // 2. let x = the resulting string
            let x = doc.get()
            console.log('x = ' + x)

            // // 3. use the code for sending these edits over the wire to create a new dt
            let updates = dt_get_patches(doc)
            console.log(updates)

            let new_doc = new Doc('server')
            apply_updates(new_doc, updates)
            let y = new_doc.get()
            console.log('y = ' + y)

            // 4. is the resulting string == x?
            console.log(x == y)
            if (x != y && n < best_n) {
                best_n = n
                best_seed = seed
            }

            // 5. test dt_get
            let z = dt_get(doc, doc.getRemoteVersion().map(x => x.join('-'))).get()
            console.log('z = ' + z)
            console.log(x == z)
            if (x != z && n < best_n) {
                best_n = n
                best_seed = seed
            }

            // 6. test dt_get_patches(doc, version)
            if (true) {
                let [_agents, versions, _parentss] = dt_parse([...doc.toBytes()])
                let v = []
                for (let i = 0; i < versions.length; i++)
                    if (Math.random() > 0.5) v.push(versions[i].join('-'))

                console.log(`v:${v}`)

                let temp_doc = dt_get(doc, v)
                console.log(`temp_doc1:${temp_doc.get()}`)

                let updates = dt_get_patches(doc, v)
                console.log(`updates:`, updates)

                apply_updates(temp_doc, updates)
                console.log(`temp_doc2:${temp_doc.get()}`)
                if (temp_doc.get() != doc.get() && n < best_n) {
                    best_n = n
                    best_seed = seed
                }
            }
        } catch (e) {
            if (n < best_n) {
                best_n = n
                best_seed = seed
            }
        }
    }
    og_log(`best_seed = ${best_seed}, best_n = ${best_n}`)
}

function make_random_edit(doc) {
    let [agents, versions, _parentss] = dt_parse([...doc.toBytes()])

    let agent = (agents.length && Math.random() > 0.5) ?
        agents[Math.floor(Math.random() * agents.length)] :
        Math.random().toString(36).slice(2)

    let include_versions = []
    let base_seq = -1
    for (let i = 0; i < versions.length; i++) {
        let [a, seq] = versions[i]
        if (a == agent || Math.random() > 0.5) {
            include_versions.push(a + '-' + seq)
            if (a == agent && seq > base_seq) base_seq = seq
        }
    }
    base_seq++

    console.log({agents, versions, include_versions})

    let parent_doc = dt_get(doc, include_versions)

    let parents = parent_doc.getRemoteVersion().map(x => x.join('-'))

    let len = parent_doc.len()
    console.log(`len = ${len}`)

    if (len && Math.random() > 0.5) {
        // delete
        let start = Math.floor(Math.random() * len)
        let del_len = Math.floor(Math.random() * (len - start - 1)) + 1

        for (let i = 0; i < del_len; i++) {
            let v = `${agent}-${base_seq++}`
            let args = [v, parents, start + del_len - 1 - i, null]
            console.log(args)
            doc.mergeBytes(dt_create_bytes(...args))
            parents = [v]
        }
    } else {
        // insert
        let start = Math.floor(Math.random() * (len + 1))
        let ins_len = Math.floor(Math.random() * 10) + 1

        for (let i = 0; i < ins_len; i++) {
            let v = `${agent}-${base_seq++}`
            let args = [v, parents, start++, getRandomCharacter()]
            console.log(args)
            doc.mergeBytes(dt_create_bytes(...args))
            parents = [v]
        }
    }

    // work here
    console.log(`doc => ${doc.get()}`)
}

function apply_updates(doc, updates) {
    for (let u of updates) {
        u.range = u.range.match(/\d+/g).map((x) => parseInt(x))
        u.content = [...u.content]

        let v = u.version
        let ps = u.parents

        console.log('UPDATE:', u)

        // delete
        for (let i = u.range[1] - 1; i >= u.range[0]; i--) {

            // work here
            let args = [v, ps, i, null]
            console.log(`args`, args)

            doc.mergeBytes(dt_create_bytes(...args))
            ps = [v]
            v = decode_version(v)
            v = `${v[0]}-${v[1] + 1}`
        }
        // insert
        for (let i = 0; i < u.content?.length ?? 0; i++) {
            let c = u.content[i]

            // work here
            let args = [v, ps, u.range[0] + i, c]
            console.log(`args`, args)

            doc.mergeBytes(dt_create_bytes(...args))
            ps = [v]
            v = decode_version(v)
            v = `${v[0]}-${v[1] + 1}`
        }
    }
}

//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////

function getRandomCharacter() {
    const characters = [
        // ASCII characters
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
        'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '+', '=',

        // Unicode characters (each is a single code point)
        'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', // Greek letters
        '零', '一', '二', '三', '四', '五', '六', '七', // Chinese numerals
        '☀', '☁', '☂', '☃', '☄', '★', '☆', '☇', // Miscellaneous symbols
        '🌈', '🌞', '🌝', '🌚', '🌕', '🌖', '🌗', '🌘', // Emoji (may be multiple UTF-16 units)
        'Ω', 'π', '∑', '√', '∫', '∀', '∂', '∃', // Mathematical symbols
        'あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', // Japanese Hiragana
        'ا', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ', 'د', // Arabic letters
    ];

    const randomIndex = Math.floor(Math.random() * characters.length);
    return characters[randomIndex];
}

function decode_version(v) {
    let m = v.match(/^(.*)-(\d+)$/s)
    if (!m) throw new Error(`invalid actor-seq version: ${v}`)
    return [m[1], parseInt(m[2])]
}

/////////

// the next two functions added by me

function create_rand(seed) {
    if (typeof (seed) == 'string') {
        var t = new MersenneTwister(0)
        var a = []
        for (var i = 0; i < seed.length; i++)
            a[i] = seed.charCodeAt(i)
        t.init_by_array(a, a.length)
    } else if (typeof (seed) == 'number') {
        var t = new MersenneTwister(seed)
    } else {
        var t = new MersenneTwister()
    }
    return () => t.random()
}

Math.randomSeed = function (seed) {
    var r = create_rand(seed)
    Math.random = () => r()
}

/* The following piece of code is an implementation of MersenneTwister object
   taken from https://gist.github.com/banksean/300494, with one method 
   xor_array(array, size) added.
*/

/*
  I've wrapped Makoto Matsumoto and Takuji Nishimura's code in a namespace
  so it's better encapsulated. Now you can have multiple random number generators
  and they won't stomp all over eachother's state.
  
  If you want to use this as a substitute for Math.random(), use the random()
  method like so:
  
  var m = new MersenneTwister();
  var randomNumber = m.random();
  
  You can also call the other genrand_{foo}() methods on the instance.

  If you want to use a specific seed in order to get a repeatable random
  sequence, pass an integer into the constructor:

  var m = new MersenneTwister(123);

  and that will always produce the same random sequence.

  Sean McCullough (banksean@gmail.com)
*/

/* 
   A C-program for MT19937, with initialization improved 2002/1/26.
   Coded by Takuji Nishimura and Makoto Matsumoto.
 
   Before using, initialize the state by using init_genrand(seed)  
   or init_by_array(init_key, key_length).
 
   Copyright (C) 1997 - 2002, Makoto Matsumoto and Takuji Nishimura,
   All rights reserved.                          
 
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:
 
     1. Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.
 
     2. Redistributions in binary form must reproduce the above copyright
        notice, this list of conditions and the following disclaimer in the
        documentation and/or other materials provided with the distribution.
 
     3. The names of its contributors may not be used to endorse or promote 
        products derived from this software without specific prior written 
        permission.
 
   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR
   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 
 
   Any feedback is very welcome.
   http://www.math.sci.hiroshima-u.ac.jp/~m-mat/MT/emt.html
   email: m-mat @ math.sci.hiroshima-u.ac.jp (remove space)
*/

var MersenneTwister = function (seed) {
    if (seed == undefined) {
        seed = new Date().getTime();
    }
    /* Period parameters */
    this.N = 624;
    this.M = 397;
    this.MATRIX_A = 0x9908b0df;   /* constant vector a */
    this.UPPER_MASK = 0x80000000; /* most significant w-r bits */
    this.LOWER_MASK = 0x7fffffff; /* least significant r bits */

    this.mt = new Array(this.N); /* the array for the state vector */
    this.mti = this.N + 1; /* mti==N+1 means mt[N] is not initialized */

    this.init_genrand(seed);
}

/* initializes mt[N] with a seed */
MersenneTwister.prototype.init_genrand = function (s) {
    this.mt[0] = s >>> 0;
    for (this.mti = 1; this.mti < this.N; this.mti++) {
        var s = this.mt[this.mti - 1] ^ (this.mt[this.mti - 1] >>> 30);
        this.mt[this.mti] = (((((s & 0xffff0000) >>> 16) * 1812433253) << 16) + (s & 0x0000ffff) * 1812433253)
            + this.mti;
        /* See Knuth TAOCP Vol2. 3rd Ed. P.106 for multiplier. */
        /* In the previous versions, MSBs of the seed affect   */
        /* only MSBs of the array mt[].                        */
        /* 2002/01/09 modified by Makoto Matsumoto             */
        this.mt[this.mti] >>>= 0;
        /* for >32 bit machines */
    }
}

/* initialize by an array with array-length */
/* init_key is the array for initializing keys */
/* key_length is its length */
/* slight change for C++, 2004/2/26 */
MersenneTwister.prototype.init_by_array = function (init_key, key_length) {
    var i, j, k;
    this.init_genrand(19650218);
    i = 1; j = 0;
    k = (this.N > key_length ? this.N : key_length);
    for (; k; k--) {
        var s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)
        this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1664525) << 16) + ((s & 0x0000ffff) * 1664525)))
            + init_key[j] + j; /* non linear */
        this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */
        i++; j++;
        if (i >= this.N) { this.mt[0] = this.mt[this.N - 1]; i = 1; }
        if (j >= key_length) j = 0;
    }
    for (k = this.N - 1; k; k--) {
        var s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
        this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1566083941) << 16) + (s & 0x0000ffff) * 1566083941))
            - i; /* non linear */
        this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */
        i++;
        if (i >= this.N) { this.mt[0] = this.mt[this.N - 1]; i = 1; }
    }

    this.mt[0] = 0x80000000; /* MSB is 1; assuring non-zero initial array */
}

/* XORs the mt array with a given array xor_key of length key_length */
MersenneTwister.prototype.xor_array = function (xor_key, key_length) {
    var i, j;
    j = 0;
    for (i = 0; i < this.N; i++) {
        this.mt[i] ^= xor_key[j];
        this.mt[i] >>>= 0;
        j++;
        if (j >= key_length) j = 0;
    }
}

/* generates a random number on [0,0xffffffff]-interval */
MersenneTwister.prototype.genrand_int32 = function () {
    var y;
    var mag01 = new Array(0x0, this.MATRIX_A);
    /* mag01[x] = x * MATRIX_A  for x=0,1 */

    if (this.mti >= this.N) { /* generate N words at one time */
        var kk;

        if (this.mti == this.N + 1)   /* if init_genrand() has not been called, */
            this.init_genrand(5489); /* a default initial seed is used */

        for (kk = 0; kk < this.N - this.M; kk++) {
            y = (this.mt[kk] & this.UPPER_MASK) | (this.mt[kk + 1] & this.LOWER_MASK);
            this.mt[kk] = this.mt[kk + this.M] ^ (y >>> 1) ^ mag01[y & 0x1];
        }
        for (; kk < this.N - 1; kk++) {
            y = (this.mt[kk] & this.UPPER_MASK) | (this.mt[kk + 1] & this.LOWER_MASK);
            this.mt[kk] = this.mt[kk + (this.M - this.N)] ^ (y >>> 1) ^ mag01[y & 0x1];
        }
        y = (this.mt[this.N - 1] & this.UPPER_MASK) | (this.mt[0] & this.LOWER_MASK);
        this.mt[this.N - 1] = this.mt[this.M - 1] ^ (y >>> 1) ^ mag01[y & 0x1];

        this.mti = 0;
    }

    y = this.mt[this.mti++];

    /* Tempering */
    y ^= (y >>> 11);
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= (y >>> 18);

    return y >>> 0;
}

/* generates a random number on [0,0x7fffffff]-interval */
MersenneTwister.prototype.genrand_int31 = function () {
    return (this.genrand_int32() >>> 1);
}

/* generates a random number on [0,1]-real-interval */
MersenneTwister.prototype.genrand_real1 = function () {
    return this.genrand_int32() * (1.0 / 4294967295.0);
    /* divided by 2^32-1 */
}

/* generates a random number on [0,1)-real-interval */
MersenneTwister.prototype.random = function () {
    return this.genrand_int32() * (1.0 / 4294967296.0);
    /* divided by 2^32 */
}

/* generates a random number on (0,1)-real-interval */
MersenneTwister.prototype.genrand_real3 = function () {
    return (this.genrand_int32() + 0.5) * (1.0 / 4294967296.0);
    /* divided by 2^32 */
}

/* generates a random number on [0,1) with 53-bit resolution*/
MersenneTwister.prototype.genrand_res53 = function () {
    var a = this.genrand_int32() >>> 5, b = this.genrand_int32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
}

/* These real versions are due to Isaku Wada, 2002/01/09 added */

////////////////////////////////////////////////////////////////////
main()
