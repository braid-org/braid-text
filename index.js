
let { Doc, OpLog, Branch } = require("@braid.org/diamond-types-node")
let braidify = require("braid-http").http_server
let fs = require("fs")

let braid_text = {
    verbose: false,
    db_folder: './braid-text-db',
    length_cache_size: 10,
    cache: {}
}

let waiting_puts = 0

let max_encoded_key_size = 240

braid_text.serve = async (req, res, options = {}) => {
    options = {
        key: req.url.split('?')[0], // Default key
        put_cb: (key, val) => { },  // Default callback when a PUT changes a key
        ...options                  // Override with all options passed in
    }

    braid_text.free_cors(res)

    function my_end(statusCode, x, statusText, headers) {
        res.writeHead(statusCode, statusText, headers)
        res.end(x ?? '')
    }

    let resource = null
    try {
        resource = await get_resource(options.key)

        braidify(req, res)
        if (res.is_multiplexer) return
    } catch (e) {
        return my_end(500, "The server failed to process this request. The error generated was: " + e)
    }

    let peer = req.headers["peer"]

    let merge_type = req.headers["merge-type"]
    if (!merge_type) merge_type = 'simpleton'
    if (merge_type !== 'simpleton' && merge_type !== 'dt') return my_end(400, `Unknown merge type: ${merge_type}`)

    // set default content type of text/plain
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'text/plain')

    // no matter what the content type is,
    // we want to set the charset to utf-8
    const contentType = res.getHeader('Content-Type')
    const parsedContentType = contentType.split(';').map(part => part.trim())
    const charsetParam = parsedContentType.find(part => part.toLowerCase().startsWith('charset='))
    if (!charsetParam)
        res.setHeader('Content-Type', `${contentType}; charset=utf-8`)
    else if (charsetParam.toLowerCase() !== 'charset=utf-8') {
        // Replace the existing charset with utf-8
        const updatedContentType = parsedContentType
            .map(part => (part.toLowerCase().startsWith('charset=') ? 'charset=utf-8' : part))
            .join('; ');
        res.setHeader('Content-Type', updatedContentType);
    }

    if (req.method == "OPTIONS") return my_end(200)

    if (req.method == "DELETE") {
        await braid_text.delete(resource)
        return my_end(200)
    }

    var get_current_version = () => ascii_ify(
        resource.doc.getRemoteVersion().map(x => x.join("-")).sort()
            .map(x => JSON.stringify(x)).join(", "))

    if (req.method == "GET" || req.method == "HEAD") {
        // make sure we have the necessary version and parents
        var unknowns = []
        for (var event of (req.version || []).concat(req.parents || [])) {
            var [actor, seq] = decode_version(event)
            if (!resource.actor_seqs[actor]?.has(seq))
                unknowns.push(event)
        }
        if (unknowns.length)
            return my_end(309, '', "Version Unknown", {
                Version: ascii_ify(unknowns.map(e => JSON.stringify(e)).join(', '))
            })

        if (!req.subscribe) {
            res.setHeader("Accept-Subscribe", "true")

            // special case for HEAD asking for version/parents,
            // to be faster by not reconstructing body
            if (req.method === "HEAD" && (req.version || req.parents))
                return my_end(200)

            let x = null
            try {
                x = await braid_text.get(resource, {
                    version: req.version,
                    parents: req.parents,
                    transfer_encoding: req.headers['accept-transfer-encoding']
                })
            } catch (e) {
                return my_end(500, "The server failed to get something. The error generated was: " + e)
            }

            if (req.headers['accept-transfer-encoding'] === 'dt') {
                res.setHeader("Current-Version", get_current_version())
                res.setHeader("X-Transfer-Encoding", 'dt')
                res.setHeader("Content-Length", x.body.length)
                return my_end(209, req.method === "HEAD" ? null : x.body, 'Multiresponse')
            } else {
                if (req.version || req.parents)
                    res.setHeader("Current-Version", get_current_version())
                res.setHeader("Version", ascii_ify(x.version.map((x) => JSON.stringify(x)).join(", ")))
                var buffer = Buffer.from(x.body, "utf8")
                res.setHeader("Repr-Digest", `sha-256=:${require('crypto').createHash('sha256').update(buffer).digest('base64')}:`)
                res.setHeader("Content-Length", buffer.length)
                return my_end(200, req.method === "HEAD" ? null : buffer)
            }
        } else {
            if (!res.hasHeader("editable")) res.setHeader("Editable", "true")
            res.setHeader("Merge-Type", merge_type)
            res.setHeader("Current-Version", get_current_version())
            if (req.method == "HEAD") return my_end(200)

            let options = {
                peer,
                version: req.version,
                parents: req.parents,
                merge_type,
                accept_encoding:
                    req.headers['x-accept-encoding'] ??
                    req.headers['accept-encoding'],
                subscribe: x => res.sendVersion(x),
                write: (x) => res.write(x)
            }

            res.startSubscription({
                onClose: () => {
                    if (merge_type === "dt") resource.clients.delete(options)
                    else resource.simpleton_clients.delete(options)
                }
            })

            try {
                return await braid_text.get(resource, options)
            } catch (e) {
                return my_end(500, "The server failed to get something. The error generated was: " + e)
            }
        }
    }

    if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
        if (waiting_puts >= 100) {
            console.log(`The server is busy.`)
            return my_end(503, "The server is busy.")
        }

        waiting_puts++
        if (braid_text.verbose) console.log(`waiting_puts(after++) = ${waiting_puts}`)
        let done_my_turn = (statusCode, x, statusText, headers) => {
            waiting_puts--
            if (braid_text.verbose) console.log(`waiting_puts(after--) = ${waiting_puts}`)
            my_end(statusCode, x, statusText, headers)
        }

        try {
            var patches = await req.patches()
            for (let p of patches) p.content = p.content_text

            let body = null
            if (patches[0]?.unit === 'everything') {
                body = patches[0].content
                patches = null
            }

            if (req.parents) {
                await wait_for_events(
                    options.key,
                    req.parents,
                    resource.actor_seqs,
                    // approximation of memory usage for this update
                    body ? body.length :
                        patches.reduce((a, b) => a + b.range.length + b.content.length, 0),
                    options.recv_buffer_max_time,
                    options.recv_buffer_max_space)

                // make sure we have the necessary parents now
                var unknowns = []
                for (var event of req.parents) {
                    var [actor, seq] = decode_version(event)
                    if (!resource.actor_seqs[actor]?.has(seq)) unknowns.push(event)
                }
                if (unknowns.length)
                    return done_my_turn(309, '', "Version Unknown", {
                        Version: ascii_ify(unknowns.map(e => JSON.stringify(e)).join(', ')),
                        'Retry-After': '1'
                    })
            }

            var {change_count} = await braid_text.put(resource, { peer, version: req.version, parents: req.parents, patches, body, merge_type })

            if (req.version) got_event(options.key, req.version[0], change_count)
           
            res.setHeader("Version", get_current_version())

            options.put_cb(options.key, resource.val)
        } catch (e) {
            console.log(`${req.method} ERROR: ${e.stack}`)
            return done_my_turn(500, "The server failed to apply this version. The error generated was: " + e)
        }

        return done_my_turn(200)
    }

    throw new Error("unknown")
}

braid_text.delete = async (key) => {
    await braid_text.put(key, {body: ''})
}

braid_text.get = async (key, options) => {
    if (!options) {
        // if it doesn't exist already, don't create it in this case
        if (!braid_text.cache[key]) return
        return (await get_resource(key)).val
    }

    if (options.version) validate_version_array(options.version)
    if (options.parents) validate_version_array(options.parents)

    let resource = (typeof key == 'string') ? await get_resource(key) : key
    var version = resource.doc.getRemoteVersion().map((x) => x.join("-")).sort()

    if (!options.subscribe) {
        if (options.transfer_encoding === 'dt') {
            // optimization: if requesting current version
            // pretend as if they didn't set a version,
            // and let it be handled as the default
            var op_v = options.version
            if (op_v && v_eq(op_v, version)) op_v = null

            var bytes = null
            if (op_v || options.parents) {
                if (op_v) {
                    var doc = dt_get(resource.doc, op_v)
                    bytes = doc.toBytes()
                } else {
                    bytes = resource.doc.toBytes()
                    var doc = Doc.fromBytes(bytes)
                }
                if (options.parents) {
                    bytes = doc.getPatchSince(
                        dt_get_local_version(bytes, options.parents))
                }
                doc.free()
            } else bytes = resource.doc.toBytes()
            return { body: bytes }
        }

        return options.version || options.parents ? {
                version: options.version || options.parents,
                body: dt_get_string(resource.doc, options.version || options.parents)
            } : {
                version,
                body: resource.doc.get()
            }
    } else {
        if (options.merge_type != "dt") {
            let x = { version }

            if (!options.parents && !options.version) {
                x.parents = []
                x.body = resource.doc.get()
                options.subscribe(x)
            } else {
                x.parents = options.version ? options.version : options.parents
                options.my_last_seen_version = x.parents

                // only send them a version from these parents if we have these parents (otherwise we'll assume these parents are more recent, probably versions they created but haven't sent us yet, and we'll send them appropriate rebased updates when they send us these versions)
                let local_version = OpLog_remote_to_local(resource.doc, x.parents)
                if (local_version) {
                    x.patches = get_xf_patches(resource.doc, local_version)
                    options.subscribe(x)
                }
            }

            options.my_last_sent_version = x.version
            resource.simpleton_clients.add(options)
        } else {
            if (resource.need_defrag) {
                if (braid_text.verbose) console.log(`doing defrag..`)
                resource.need_defrag = false
                resource.doc = defrag_dt(resource.doc)
            }

            if (options.accept_encoding?.match(/updates\s*\((.*)\)/)?.[1].split(',').map(x=>x.trim()).includes('dt')) {
                var bytes = resource.doc.toBytes()
                if (options.parents) {
                    var doc = Doc.fromBytes(bytes)
                    bytes = doc.getPatchSince(
                        dt_get_local_version(bytes, options.parents))
                    doc.free()
                }
                options.subscribe({ encoding: 'dt', body: bytes })
            } else {
                var updates = null
                if (!options.parents && !options.version) {
                    options.subscribe({
                        version: [],
                        parents: [],
                        body: "",
                    })

                    updates = dt_get_patches(resource.doc)
                } else {
                    // Then start the subscription from the parents in options
                    updates = dt_get_patches(resource.doc, options.parents || options.version)
                }

                for (let u of updates)
                    options.subscribe({
                        version: [u.version],
                        parents: u.parents,
                        patches: [{ unit: u.unit, range: u.range, content: u.content }],
                    })

                // Output at least *some* data, or else chrome gets confused and
                // thinks the connection failed.  This isn't strictly necessary,
                // but it makes fewer scary errors get printed out in the JS
                // console.
                if (updates.length === 0) options.write?.("\r\n")
            }

            resource.clients.add(options)
        }
    }
}

braid_text.forget = async (key, options) => {
    if (!options) throw new Error('options is required')

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    if (options.merge_type != "dt")
        resource.simpleton_clients.delete(options)
    else resource.clients.delete(options)
}

braid_text.put = async (key, options) => {
    let { version, patches, body, peer } = options

    // support for json patch puts..
    if (patches?.length && patches.every(x => x.unit === 'json')) {
        let resource = (typeof key == 'string') ? await get_resource(key) : key
        
        let x = JSON.parse(resource.doc.get())
        for (let p of patches)
            apply_patch(x, p.range, p.content === '' ? undefined : JSON.parse(p.content))

        return await braid_text.put(key, {
            body: JSON.stringify(x, null, 4)
        })
    }

    if (version) validate_version_array(version)

    // translate a single parent of "root" to the empty array (same meaning)
    let options_parents = options.parents
    if (options_parents?.length === 1 && options_parents[0] === 'root')
        options_parents = []

    if (options_parents) validate_version_array(options_parents)
    if (body != null && patches) throw new Error(`cannot have a body and patches`)
    if (body != null && (typeof body !== 'string')) throw new Error(`body must be a string`)
    if (patches) validate_patches(patches)

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    if (options_parents) {
        // make sure we have all these parents
        for (let p of options_parents) {
            let P = decode_version(p)
            if (!resource.actor_seqs[P[0]]?.has(P[1]))
                throw new Error(`missing parent version: ${p}`)
        }
    }

    let parents = resource.doc.getRemoteVersion().map((x) => x.join("-")).sort()
    let og_parents = options_parents || parents

    let max_pos = resource.length_cache.get('' + og_parents) ??
        (v_eq(parents, og_parents) ? resource.doc.len() : dt_len(resource.doc, og_parents))
    
    if (body != null) {
        patches = [{
            unit: 'text',
            range: `[0:${max_pos}]`,
            content: body
        }]
    }

    let og_patches = patches
    patches = patches.map((p) => ({
        ...p,
        range: p.range.match(/\d+/g).map((x) => parseInt(x)),
        content_codepoints: [...p.content],
    })).sort((a, b) => a.range[0] - b.range[0])

    // validate patch positions
    let must_be_at_least = 0
    for (let p of patches) {
        if (p.range[0] < must_be_at_least || p.range[0] > max_pos) throw new Error(`invalid patch range position: ${p.range[0]}`)
        if (p.range[1] < p.range[0] || p.range[1] > max_pos) throw new Error(`invalid patch range position: ${p.range[1]}`)
        must_be_at_least = p.range[1]
    }

    let change_count = patches.reduce((a, b) => a + b.content_codepoints.length + (b.range[1] - b.range[0]), 0)

    let og_v = version?.[0] || `${(is_valid_actor(peer) && peer) || Math.random().toString(36).slice(2, 7)}-${change_count - 1}`

    let v = decode_version(og_v)

    resource.length_cache.put(`${v[0]}-${v[1]}`, patches.reduce((a, b) =>
        a + (b.content_codepoints?.length ?? 0) - (b.range[1] - b.range[0]),
        max_pos))

    // validate version: make sure we haven't seen it already
    if (resource.actor_seqs[v[0]]?.has(v[1])) {

        if (!options.validate_already_seen_versions) return

        // if we have seen it already, make sure it's the same as before
        let updates = dt_get_patches(resource.doc, og_parents)

        let seen = {}
        for (let u of updates) {
            u.version = decode_version(u.version)

            if (!u.content) {
                // delete
                let v = u.version
                for (let i = 0; i < u.end - u.start; i++) {
                    let ps = (i < u.end - u.start - 1) ? [`${v[0]}-${v[1] - i - 1}`] : u.parents
                    seen[JSON.stringify([v[0], v[1] - i, ps, u.start + i])] = true
                }
            } else {
                // insert
                let v = u.version
                let content = [...u.content]
                for (let i = 0; i < content.length; i++) {
                    let ps = (i > 0) ? [`${v[0]}-${v[1] - content.length + i}`] : u.parents
                    seen[JSON.stringify([v[0], v[1] + 1 - content.length + i, ps, u.start + i, content[i]])] = true
                }
            }
        }

        v = `${v[0]}-${v[1] + 1 - change_count}`
        let ps = og_parents
        let offset = 0
        for (let p of patches) {
            // delete
            for (let i = p.range[0]; i < p.range[1]; i++) {
                let vv = decode_version(v)

                if (!seen[JSON.stringify([vv[0], vv[1], ps, p.range[1] - 1 + offset])]) throw new Error('invalid update: different from previous update with same version')

                offset--
                ps = [v]
                v = vv
                v = `${v[0]}-${v[1] + 1}`
            }
            // insert
            for (let i = 0; i < p.content_codepoints?.length ?? 0; i++) {
                let vv = decode_version(v)
                let c = p.content_codepoints[i]

                if (!seen[JSON.stringify([vv[0], vv[1], ps, p.range[1] + offset, c])]) throw new Error('invalid update: different from previous update with same version')

                offset++
                ps = [v]
                v = vv
                v = `${v[0]}-${v[1] + 1}`
            }
        }

        // we already have this version, so nothing left to do
        return
    }
    if (!resource.actor_seqs[v[0]]) resource.actor_seqs[v[0]] = new RangeSet()
    resource.actor_seqs[v[0]].add_range(v[1] + 1 - change_count, v[1])

    // reduce the version sequence by the number of char-edits
    v = `${v[0]}-${v[1] + 1 - change_count}`

    let ps = og_parents

    let v_before = resource.doc.getLocalVersion()

    let bytes = []

    let offset = 0
    for (let p of patches) {
        // delete
        let del = p.range[1] - p.range[0]
        if (del) {
            bytes.push(dt_create_bytes(v, ps, p.range[0] + offset, del, null))
            offset -= del
            v = decode_version(v)
            ps = [`${v[0]}-${v[1] + (del - 1)}`]
            v = `${v[0]}-${v[1] + del}`
        }
        // insert
        if (p.content?.length) {
            bytes.push(dt_create_bytes(v, ps, p.range[1] + offset, 0, p.content))
            offset += p.content_codepoints.length
            v = decode_version(v)
            ps = [`${v[0]}-${v[1] + (p.content_codepoints.length - 1)}`]
            v = `${v[0]}-${v[1] + p.content_codepoints.length}`
        }
    }

    for (let b of bytes) resource.doc.mergeBytes(b)
    resource.val = resource.doc.get()

    resource.need_defrag = true

    var post_commit_updates = []

    if (options.merge_type != "dt") {
        patches = get_xf_patches(resource.doc, v_before)
        if (braid_text.verbose) console.log(JSON.stringify({ patches }))

        let version = resource.doc.getRemoteVersion().map((x) => x.join("-")).sort()

        for (let client of resource.simpleton_clients) {
            if (peer && client.peer === peer) {
                client.my_last_seen_version = [og_v]
            }

            function set_timeout(time_override) {
                if (client.my_timeout) clearTimeout(client.my_timeout)
                client.my_timeout = setTimeout(() => {
                    // if the doc has been freed, exit early
                    if (resource.doc.__wbg_ptr === 0) return

                    let version = resource.doc.getRemoteVersion().map((x) => x.join("-")).sort()
                    let x = { version }
                    x.parents = client.my_last_seen_version

                    if (braid_text.verbose) console.log("rebasing after timeout.. ")
                    if (braid_text.verbose) console.log("    client.my_unused_version_count = " + client.my_unused_version_count)
                    x.patches = get_xf_patches(resource.doc, OpLog_remote_to_local(resource.doc, client.my_last_seen_version))

                    if (braid_text.verbose) console.log(`sending from rebase: ${JSON.stringify(x)}`)
                    client.subscribe(x)
                    client.my_last_sent_version = x.version

                    delete client.my_timeout
                }, time_override ?? Math.min(3000, 23 * Math.pow(1.5, client.my_unused_version_count - 1)))
            }

            if (client.my_timeout) {
                if (peer && client.peer === peer) {
                    if (!v_eq(client.my_last_sent_version, og_parents)) {
                        // note: we don't add to client.my_unused_version_count,
                        // because we're already in a timeout;
                        // we'll just extend it here..
                        set_timeout()
                    } else {
                        // hm.. it appears we got a correctly parented version,
                        // which suggests that maybe we can stop the timeout early
                        set_timeout(0)
                    }
                }
                continue
            }

            let x = { version }
            if (peer && client.peer === peer) {
                if (!v_eq(client.my_last_sent_version, og_parents)) {
                    client.my_unused_version_count = (client.my_unused_version_count ?? 0) + 1
                    set_timeout()
                    continue
                } else {
                    delete client.my_unused_version_count
                }

                x.parents = options.version
                if (!v_eq(version, options.version)) {
                    if (braid_text.verbose) console.log("rebasing..")
                    x.patches = get_xf_patches(resource.doc, OpLog_remote_to_local(resource.doc, [og_v]))
                } else {
                    // this client already has this version,
                    // so let's pretend to send it back, but not
                    if (braid_text.verbose) console.log(`not reflecting back to simpleton`)
                    client.my_last_sent_version = x.version
                    continue
                }
            } else {
                x.parents = parents
                x.patches = patches
            }
            if (braid_text.verbose) console.log(`sending: ${JSON.stringify(x)}`)
            post_commit_updates.push([client, x])
            client.my_last_sent_version = x.version
        }
    } else {
        if (resource.simpleton_clients.size) {
            let version = resource.doc.getRemoteVersion().map((x) => x.join("-")).sort()
            patches = get_xf_patches(resource.doc, v_before)
            let x = { version, parents, patches }
            if (braid_text.verbose) console.log(`sending: ${JSON.stringify(x)}`)
            for (let client of resource.simpleton_clients) {
                if (client.my_timeout) continue
                post_commit_updates.push([client, x])
                client.my_last_sent_version = x.version
            }
        }
    }

    var x = {
        version: [og_v],
        parents: og_parents,
        patches: og_patches,
    }
    for (let client of resource.clients) {
        if (!peer || client.peer !== peer)
            post_commit_updates.push([client, x])
    }

    await resource.db_delta(resource.doc.getPatchSince(v_before))

    for (var [client, x] of post_commit_updates) client.subscribe(x)

    return { change_count }
}

braid_text.list = async () => {
    try {
        if (braid_text.db_folder) {
            await db_folder_init()
            var pages = new Set()
            for (let x of await require('fs').promises.readdir(braid_text.db_folder)) pages.add(decode_filename(x.replace(/\.\w+$/, '')))
            return [...pages.keys()]
        } else return Object.keys(braid_text.cache)
    } catch (e) { return [] }
}

braid_text.free_cors = res => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Expose-Headers", "*")
}

async function get_resource(key) {
    let cache = braid_text.cache
    if (!cache[key]) cache[key] = new Promise(async done => {
        let resource = {key}
        resource.clients = new Set()
        resource.simpleton_clients = new Set()

        resource.doc = new Doc("server")

        let { change } = braid_text.db_folder
            ? await file_sync(key,
                (bytes) => resource.doc.mergeBytes(bytes),
                () => resource.doc.toBytes())
            : { change: () => { } }

        resource.db_delta = change

        resource.doc = defrag_dt(resource.doc)
        resource.need_defrag = false

        resource.actor_seqs = {}

        let max_version = resource.doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)
        for (let i = 0; i <= max_version; i++) {
            let v = resource.doc.localToRemoteVersion([i])[0]
            if (!resource.actor_seqs[v[0]]) resource.actor_seqs[v[0]] = new RangeSet()
            resource.actor_seqs[v[0]].add_range(v[1], v[1])
        }

        resource.val = resource.doc.get()

        resource.length_cache = createSimpleCache(braid_text.length_cache_size)

        done(resource)
    })
    return await cache[key]
}

async function db_folder_init() {
    if (braid_text.verbose) console.log('__!')
    if (!db_folder_init.p) db_folder_init.p = new Promise(async done => {
        await fs.promises.mkdir(braid_text.db_folder, { recursive: true });

        // 0.0.13 -> 0.0.14
        // look for files with key-encodings over max_encoded_key_size,
        // and convert them using the new method
        // for (let x of await fs.promises.readdir(braid_text.db_folder)) {
        //     let k = x.replace(/(_[0-9a-f]{64})?\.\w+$/, '')
        //     if (k.length > max_encoded_key_size) {
        //         k = decode_filename(k)

        //         await fs.promises.rename(`${braid_text.db_folder}/${x}`, `${braid_text.db_folder}/${encode_filename(k)}${x.match(/\.\w+$/)[0]}`)
        //         await fs.promises.writeFile(`${braid_text.db_folder}/${encode_filename(k)}.name`, k)
        //     }
        // }

        // 0.0.14 -> 0.0.15
        // basically convert the 0.0.14 files back
        let convert_us = {}
        for (let x of await fs.promises.readdir(braid_text.db_folder)) {
            if (x.endsWith('.name')) {
                let encoded = convert_us[x.slice(0, -'.name'.length)] = encode_filename(await fs.promises.readFile(`${braid_text.db_folder}/${x}`, { encoding: 'utf8' }))
                if (encoded.length > max_encoded_key_size) {
                    console.log(`trying to convert file to new format, but the key is too big: ${braid_text.db_folder}/${x}`)
                    process.exit()
                }
                if (braid_text.verbose) console.log(`deleting: ${braid_text.db_folder}/${x}`)
                await fs.promises.unlink(`${braid_text.db_folder}/${x}`)
            }
        }
        if (Object.keys(convert_us).length) {
            for (let x of await fs.promises.readdir(braid_text.db_folder)) {
                let [_, k, num] = x.match(/^(.*)\.(\d+)$/s)
                if (!convert_us[k]) continue
                if (braid_text.verbose) console.log(`renaming: ${braid_text.db_folder}/${x} -> ${braid_text.db_folder}/${convert_us[k]}.${num}`)
                if (convert_us[k]) await fs.promises.rename(`${braid_text.db_folder}/${x}`, `${braid_text.db_folder}/${convert_us[k]}.${num}`)
            }
        }

        done()
    })
    await db_folder_init.p
}

async function get_files_for_key(key) {
    await db_folder_init()
    try {
        let re = new RegExp("^" + encode_filename(key).replace(/[^a-zA-Z0-9]/g, "\\$&") + "\\.\\w+$")
        return (await fs.promises.readdir(braid_text.db_folder))
            .filter((a) => re.test(a))
            .map((a) => `${braid_text.db_folder}/${a}`)
    } catch (e) { return [] }    
}

async function file_sync(key, process_delta, get_init) {
    let encoded = encode_filename(key)

    if (encoded.length > max_encoded_key_size) throw new Error(`invalid key: too long (max ${max_encoded_key_size})`)

    let currentNumber = 0
    let currentSize = 0
    let threshold = 0

    // Read existing files and sort by numbers.
    const files = (await get_files_for_key(key))
        .filter(x => x.match(/\.\d+$/))
        .sort((a, b) => parseInt(a.match(/\d+$/)[0]) - parseInt(b.match(/\d+$/)[0]))

    // Try to process files starting from the highest number.
    let done = false
    for (let i = files.length - 1; i >= 0; i--) {
        if (done) {
            await fs.promises.unlink(files[i])
            continue
        }
        try {
            const filename = files[i]
            if (braid_text.verbose) console.log(`trying to process file: ${filename}`)
            const data = await fs.promises.readFile(filename)

            let cursor = 0
            let isFirstChunk = true
            while (cursor < data.length) {
                const chunkSize = data.readUInt32LE(cursor)
                cursor += 4
                const chunk = data.slice(cursor, cursor + chunkSize)
                cursor += chunkSize

                if (isFirstChunk) {
                    isFirstChunk = false
                    threshold = chunkSize * 10
                }
                process_delta(chunk)
            }

            currentSize = data.length
            currentNumber = parseInt(filename.match(/\d+$/)[0])
            done = true
        } catch (error) {
            console.error(`Error processing file: ${files[i]}`)
            await fs.promises.unlink(files[i])
        }
    }

    let chain = Promise.resolve()
    return {
        change: async (bytes) => {
            await (chain = chain.then(async () => {
                if (!bytes) currentSize = threshold
                else currentSize += bytes.length + 4 // we account for the extra 4 bytes for uint32
                const filename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
                if (currentSize < threshold) {
                    if (braid_text.verbose) console.log(`appending to db..`)

                    let buffer = Buffer.allocUnsafe(4)
                    buffer.writeUInt32LE(bytes.length, 0)
                    await fs.promises.appendFile(filename, buffer)
                    await fs.promises.appendFile(filename, bytes)

                    if (braid_text.verbose) console.log("wrote to : " + filename)
                } else {
                    try {
                        if (braid_text.verbose) console.log(`starting new db..`)

                        currentNumber++
                        const init = get_init()
                        const buffer = Buffer.allocUnsafe(4)
                        buffer.writeUInt32LE(init.length, 0)

                        const newFilename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
                        await fs.promises.writeFile(newFilename, buffer)
                        await fs.promises.appendFile(newFilename, init)

                        if (braid_text.verbose) console.log("wrote to : " + newFilename)

                        currentSize = 4 + init.length
                        threshold = currentSize * 10
                        try {
                            await fs.promises.unlink(filename)
                        } catch (e) { }
                    } catch (e) {
                        if (braid_text.verbose) console.log(`e = ${e.stack}`)
                    }
                }
            }))
        }
    }
}

async function wait_for_events(
    key,
    events,
    actor_seqs,
    my_space,
    max_time = 3000,
    max_space = 5 * 1024 * 1024) {

    if (!wait_for_events.namespaces) wait_for_events.namespaces = {}
    if (!wait_for_events.namespaces[key]) wait_for_events.namespaces[key] = {}
    var ns = wait_for_events.namespaces[key]

    if (!wait_for_events.space_used) wait_for_events.space_used = 0
    if (wait_for_events.space_used + my_space > max_space) return
    wait_for_events.space_used += my_space

    var p_done = null
    var p = new Promise(done => p_done = done)

    var missing = 0
    var on_find = () => {
        missing--
        if (!missing) p_done()
    }
    
    for (let event of events) {
        var [actor, seq] = decode_version(event)
        if (actor_seqs?.[actor]?.has(seq)) continue
        missing++

        if (!ns.actor_seqs) ns.actor_seqs = {}
        if (!ns.actor_seqs[actor]) ns.actor_seqs[actor] = []
        sorted_set_insert(ns.actor_seqs[actor], seq)

        if (!ns.events) ns.events = {}
        if (!ns.events[event]) ns.events[event] = new Set()
        ns.events[event].add(on_find)
    }

    if (missing) {
        var t = setTimeout(() => {
            for (let event of events) {
                var [actor, seq] = decode_version(event)
                
                var cbs = ns.events[event]
                if (!cbs) continue

                cbs.delete(on_find)
                if (cbs.size) continue

                delete ns.events[event]

                var seqs = ns.actor_seqs[actor]
                if (!seqs) continue

                sorted_set_delete(seqs, seq)
                if (seqs.length) continue
                
                delete ns.actor_seqs[actor]
            }
            p_done()
        }, max_time)

        await p

        clearTimeout(t)
    }
    wait_for_events.space_used -= my_space
}

async function got_event(key, event, change_count) {
    var ns = wait_for_events.namespaces?.[key]
    if (!ns) return

    var [actor, seq] = decode_version(event)
    var base_seq = seq + 1 - change_count

    var seqs = ns.actor_seqs?.[actor]
    if (!seqs) return

    // binary search to find the first i >= base_seq
    var i = 0, end = seqs.length
    while (i < end) {
        var mid = (i + end) >> 1
        seqs[mid] < base_seq ? i = mid + 1 : end = mid
    }
    var start = i

    // iterate up through seq
    while (i < seqs.length && seqs[i] <= seq) {
        var e = actor + "-" + seqs[i]
        ns.events?.[e]?.forEach(cb => cb())
        delete ns.events?.[e]
        i++
    }

    seqs.splice(start, i - start)
    if (!seqs.length) delete ns.actor_seqs[actor]
}

//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////

function dt_len(doc, version) {
    return count_code_points(dt_get_string(doc, version))
}

function dt_get_string(doc, version) {
    // optimization: if version is the latest,
    // then return the current text..
    if (v_eq(version, doc.getRemoteVersion().map((x) => x.join("-")).sort()))
        return doc.get()

    var bytes = doc.toBytes()
    var oplog = OpLog.fromBytes(bytes)

    var local_version = dt_get_local_version(bytes, version)

    var b = new Branch()
    b.merge(oplog, new Uint32Array(local_version))
    var s = b.get()
    b.free()
    
    oplog.free()
    return s
}

function dt_get(doc, version, agent = null, anti_version = null) {
    if (dt_get.last_doc) dt_get.last_doc.free()

    let bytes = doc.toBytes()
    dt_get.last_doc = doc = Doc.fromBytes(bytes, agent)

    let [_agents, versions, parentss] = dt_parse([...bytes])
    if (anti_version) {
        var include_versions = new Set()
        var bad_versions = new Set(anti_version)

        for (let i = 0; i < versions.length; i++) {
            var v = versions[i].join("-")
            var ps = parentss[i].map(x => x.join('-'))
            if (bad_versions.has(v) || ps.some(x => bad_versions.has(x)))
                bad_versions.add(v)
            else
                include_versions.add(v)
        }
    } else {
        var include_versions = new Set(version)
        var looking_for = new Set(version)
        var local_version = []

        for (let i = versions.length - 1; i >= 0; i--) {
            var v = versions[i].join("-")
            var ps = parentss[i].map(x => x.join('-'))
            if (looking_for.has(v)) {
                local_version.push(i)
                looking_for.delete(v)
            }
            if (include_versions.has(v))
                ps.forEach(x => include_versions.add(x))
        }
        local_version.reverse()

        // NOTE: currently used by braid-chrome in dt.js at the bottom
        dt_get.last_local_version = new Uint32Array(local_version)

        if (looking_for.size) throw new Error(`version not found: ${version}`)
    }

    let new_doc = new Doc(agent)
    let op_runs = doc.getOpsSince([])

    let i = 0
    op_runs.forEach((op_run) => {
        if (op_run.content) op_run.content = [...op_run.content]

        let len = op_run.end - op_run.start
        let base_i = i
        for (let j = 1; j <= len; j++) {
            let I = base_i + j
            if (
                j == len ||
                parentss[I].length != 1 ||
                parentss[I][0][0] != versions[I - 1][0] ||
                parentss[I][0][1] != versions[I - 1][1] ||
                versions[I][0] != versions[I - 1][0] ||
                versions[I][1] != versions[I - 1][1] + 1
            ) {
                for (; i < I; i++) {
                    let version = versions[i].join("-")
                    if (!include_versions.has(version)) continue
                    let og_i = i
                    let content = []
                    if (op_run.content?.[i - base_i]) content.push(op_run.content[i - base_i])
                    if (!!op_run.content === op_run.fwd)
                        while (i + 1 < I && include_versions.has(versions[i + 1].join("-"))) {
                            i++
                            if (op_run.content?.[i - base_i]) content.push(op_run.content[i - base_i])
                        }
                    content = content.length ? content.join("") : null

                    new_doc.mergeBytes(
                        dt_create_bytes(
                            version,
                            parentss[og_i].map((x) => x.join("-")),
                            op_run.fwd ?
                                (op_run.content ?
                                    op_run.start + (og_i - base_i) :
                                    op_run.start) :
                                op_run.end - 1 - (i - base_i),
                            op_run.content ? 0 : i - og_i + 1,
                            content
                        )
                    )
                }
            }
        }
    })
    return new_doc
}

function dt_get_patches(doc, version = null) {
    let bytes = doc.toBytes()
    doc = Doc.fromBytes(bytes)

    let [_agents, versions, parentss] = dt_parse([...bytes])

    let op_runs = []
    if (version && v_eq(version,
        doc.getRemoteVersion().map((x) => x.join("-")).sort())) {
        // they want everything past the end, which is nothing
    } else if (version?.length) {
        let frontier = {}
        version.forEach((x) => frontier[x] = true)
        let local_version = []
        for (let i = 0; i < versions.length; i++)
            if (frontier[versions[i].join("-")]) local_version.push(i)

        local_version = new Uint32Array(local_version)

        let after_bytes = doc.getPatchSince(local_version)
        ;[_agents, versions, parentss] = dt_parse([...after_bytes])
        op_runs = doc.getOpsSince(local_version)
    } else op_runs = doc.getOpsSince([])

    doc.free()

    let i = 0
    let patches = []
    op_runs.forEach((op_run) => {
        let version = versions[i]
        let parents = parentss[i].map((x) => x.join("-")).sort()
        let start = op_run.start
        let end = start + 1
        if (op_run.content) op_run.content = [...op_run.content]
        let len = op_run.end - op_run.start
        for (let j = 1; j <= len; j++) {
            let I = i + j
            if (
                (!op_run.content && op_run.fwd) ||
                j == len ||
                parentss[I].length != 1 ||
                parentss[I][0][0] != versions[I - 1][0] ||
                parentss[I][0][1] != versions[I - 1][1] ||
                versions[I][0] != versions[I - 1][0] ||
                versions[I][1] != versions[I - 1][1] + 1
            ) {
                let s = op_run.fwd ?
                    (op_run.content ?
                        start :
                        op_run.start) :
                    (op_run.start + (op_run.end - end))
                let e = op_run.fwd ?
                    (op_run.content ?
                        end :
                        op_run.start + (end - start)) :
                    (op_run.end - (start - op_run.start))
                patches.push({
                    version: `${version[0]}-${version[1] + e - s - 1}`,
                    parents,
                    unit: "text",
                    range: op_run.content ? `[${s}:${s}]` : `[${s}:${e}]`,
                    content: op_run.content?.slice(start - op_run.start, end - op_run.start).join("") ?? "",
                    start: s,
                    end: e,
                })
                if (j == len) break
                version = versions[I]
                parents = parentss[I].map((x) => x.join("-")).sort()
                start = op_run.start + j
            }
            end++
        }
        i += len
    })
    return patches
}

function dt_parse(byte_array) {
    if (new TextDecoder().decode(new Uint8Array(byte_array.splice(0, 8))) !== "DMNDTYPS") throw new Error("dt parse error, expected DMNDTYPS")

    if (byte_array.shift() != 0) throw new Error("dt parse error, expected version 0")

    let agents = []
    let versions = []
    let parentss = []

    while (byte_array.length) {
        let id = byte_array.shift()
        let len = dt_read_varint(byte_array)
        if (id == 1) {
        } else if (id == 3) {
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                agents.push(dt_read_string(byte_array))
            }
        } else if (id == 20) {
        } else if (id == 21) {
            let seqs = {}
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                let part0 = dt_read_varint(byte_array)
                let has_jump = part0 & 1
                let agent_i = (part0 >> 1) - 1
                let run_length = dt_read_varint(byte_array)
                let jump = 0
                if (has_jump) {
                    let part2 = dt_read_varint(byte_array)
                    jump = part2 >> 1
                    if (part2 & 1) jump *= -1
                }
                let base = (seqs[agent_i] || 0) + jump

                for (let i = 0; i < run_length; i++) {
                    versions.push([agents[agent_i], base + i])
                }
                seqs[agent_i] = base + run_length
            }
        } else if (id == 23) {
            let count = 0
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                let run_len = dt_read_varint(byte_array)

                let parents = []
                let has_more = 1
                while (has_more) {
                    let x = dt_read_varint(byte_array)
                    let is_foreign = 0x1 & x
                    has_more = 0x2 & x
                    let num = x >> 2

                    if (x == 1) {
                        // no parents (e.g. parent is "root")
                    } else if (!is_foreign) {
                        parents.push(versions[count - num])
                    } else {
                        parents.push([agents[num - 1], dt_read_varint(byte_array)])
                    }
                }
                parentss.push(parents)
                count++

                for (let i = 0; i < run_len - 1; i++) {
                    parentss.push([versions[count - 1]])
                    count++
                }
            }
        } else {
            byte_array.splice(0, len)
        }
    }

    return [agents, versions, parentss]
}

function dt_get_local_version(bytes, version) {
    var looking_for = new Map()
    for (var event of version) {
        var [agent, seq] = decode_version(event)
        if (!looking_for.has(agent)) looking_for.set(agent, [])
        looking_for.get(agent).push(seq)
    }
    for (var seqs of looking_for.values())
        seqs.sort((a, b) => a - b)

    var byte_array = [...bytes]
    var local_version = []
    var local_version_base = 0

    if (new TextDecoder().decode(new Uint8Array(byte_array.splice(0, 8))) !== "DMNDTYPS") throw new Error("dt parse error, expected DMNDTYPS")

    if (byte_array.shift() != 0) throw new Error("dt parse error, expected version 0")

    let agents = []

    while (byte_array.length && looking_for.size) {
        let id = byte_array.shift()
        let len = dt_read_varint(byte_array)
        if (id == 1) {
        } else if (id == 3) {
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                agents.push(dt_read_string(byte_array))
            }
        } else if (id == 20) {
        } else if (id == 21) {
            let seqs = {}
            let goal = byte_array.length - len
            while (byte_array.length > goal && looking_for.size) {
                let part0 = dt_read_varint(byte_array)
                let has_jump = part0 & 1
                let agent_i = (part0 >> 1) - 1
                let run_length = dt_read_varint(byte_array)
                let jump = 0
                if (has_jump) {
                    let part2 = dt_read_varint(byte_array)
                    jump = part2 >> 1
                    if (part2 & 1) jump *= -1
                }
                let base = (seqs[agent_i] || 0) + jump

                var agent = agents[agent_i]
                looking_for_seqs = looking_for.get(agent)
                if (looking_for_seqs) {
                    for (var seq of splice_out_range(
                        looking_for_seqs, base, base + run_length - 1))
                        local_version.push(local_version_base + (seq - base))
                    if (!looking_for_seqs.length) looking_for.delete(agent)
                }
                local_version_base += run_length

                seqs[agent_i] = base + run_length
            }
        } else {
            byte_array.splice(0, len)
        }
    }

    if (looking_for.size) throw new Error(`version not found: ${version}`)
    return local_version

    function splice_out_range(a, s, e) {
        if (!a?.length) return [];
        let l = 0, r = a.length;
        while (l < r) {
            const m = Math.floor((l + r) / 2);
            if (a[m] < s) l = m + 1; else r = m;
        }
        const i = l;
        l = i; r = a.length;
        while (l < r) {
            const m = Math.floor((l + r) / 2);
            if (a[m] <= e) l = m + 1; else r = m;
        }
        return a.splice(i, l - i);
    }
}

function dt_read_string(byte_array) {
    return new TextDecoder().decode(new Uint8Array(byte_array.splice(0, dt_read_varint(byte_array))))
}

function dt_read_varint(byte_array) {
    let result = 0
    let shift = 0
    while (true) {
        if (byte_array.length === 0) throw new Error("byte array does not contain varint")

        let byte_val = byte_array.shift()
        result |= (byte_val & 0x7f) << shift
        if ((byte_val & 0x80) == 0) return result
        shift += 7
    }
}

function dt_create_bytes(version, parents, pos, del, ins) {
    if (del) pos += del - 1

    function write_varint(bytes, value) {
        while (value >= 0x80) {
            bytes.push((value & 0x7f) | 0x80)
            value >>= 7
        }
        bytes.push(value)
    }

    function write_string(byte_array, str) {
        let str_bytes = new TextEncoder().encode(str)
        write_varint(byte_array, str_bytes.length)
        for (let x of str_bytes) byte_array.push(x)
    }

    version = decode_version(version)
    parents = parents.map(decode_version)

    let bytes = []
    bytes = bytes.concat(Array.from(new TextEncoder().encode("DMNDTYPS")))
    bytes.push(0)

    let file_info = []
    let agent_names = []

    let agents = new Set()
    agents.add(version[0])
    for (let p of parents) agents.add(p[0])
    agents = [...agents]

    //   console.log(JSON.stringify({ agents, parents }, null, 4));

    let agent_to_i = {}
    for (let [i, agent] of agents.entries()) {
        agent_to_i[agent] = i
        write_string(agent_names, agent)
    }

    file_info.push(3)
    write_varint(file_info, agent_names.length)
    for (let x of agent_names) file_info.push(x)

    bytes.push(1)
    write_varint(bytes, file_info.length)
    for (let x of file_info) bytes.push(x)

    let branch = []

    if (parents.length) {
        let frontier = []

        for (let [i, [agent, seq]] of parents.entries()) {
            let has_more = i < parents.length - 1
            let mapped = agent_to_i[agent]
            let n = ((mapped + 1) << 1) | (has_more ? 1 : 0)
            write_varint(frontier, n)
            write_varint(frontier, seq)
        }

        branch.push(12)
        write_varint(branch, frontier.length)
        for (let x of frontier) branch.push(x)
    }

    bytes.push(10)
    write_varint(bytes, branch.length)
    for (let x of branch) bytes.push(x)

    let patches = []

    let unicode_chars = ins ? [...ins] : []

    if (ins) {
        let inserted_content_bytes = []

        inserted_content_bytes.push(0) // ins (not del, which is 1)

        inserted_content_bytes.push(13) // "content" enum (rather than compressed)

        let encoder = new TextEncoder()
        let utf8Bytes = encoder.encode(ins)

        write_varint(inserted_content_bytes, 1 + utf8Bytes.length)
        // inserted_content_bytes.push(1 + utf8Bytes.length) // length of content chunk
        inserted_content_bytes.push(4) // "plain text" enum

        for (let b of utf8Bytes) inserted_content_bytes.push(b) // actual text

        inserted_content_bytes.push(25) // "known" enum
        let known_chunk = []
        write_varint(known_chunk, unicode_chars.length * 2 + 1)
        write_varint(inserted_content_bytes, known_chunk.length)
        for (let x of known_chunk) inserted_content_bytes.push(x)

        patches.push(24)
        write_varint(patches, inserted_content_bytes.length)
        for (let b of inserted_content_bytes) patches.push(b)
    }

    // write in the version
    let version_bytes = []

    let [agent, seq] = version
    let agent_i = agent_to_i[agent]
    let jump = seq

    write_varint(version_bytes, ((agent_i + 1) << 1) | (jump != 0 ? 1 : 0))
    write_varint(version_bytes, ins ? unicode_chars.length : del)
    if (jump) write_varint(version_bytes, jump << 1)

    patches.push(21)
    write_varint(patches, version_bytes.length)
    for (let b of version_bytes) patches.push(b)

    // write in "op" bytes (some encoding of position)
    let op_bytes = []

    if (del) {
        if (pos == 0) {
            write_varint(op_bytes, 4)
        } else if (del == 1) {
            write_varint(op_bytes, pos * 16 + 6)
        } else {
            write_varint(op_bytes, del * 16 + 7)
            write_varint(op_bytes, pos * 2 + 2)
        }
    } else if (unicode_chars.length == 1) {
        if (pos == 0) write_varint(op_bytes, 0)
        else write_varint(op_bytes, pos * 16 + 2)
    } else if (pos == 0) {
        write_varint(op_bytes, unicode_chars.length * 8 + 1)
    } else {
        write_varint(op_bytes, unicode_chars.length * 8 + 3)
        write_varint(op_bytes, pos * 2)
    }

    patches.push(22)
    write_varint(patches, op_bytes.length)
    for (let b of op_bytes) patches.push(b)

    // write in parents
    let parents_bytes = []

    write_varint(parents_bytes, ins ? unicode_chars.length : del)

    if (parents.length) {
        for (let [i, [agent, seq]] of parents.entries()) {
            let has_more = i < parents.length - 1
            let agent_i = agent_to_i[agent]
            write_varint(parents_bytes, ((agent_i + 1) << 2) | (has_more ? 2 : 0) | 1)
            write_varint(parents_bytes, seq)
        }
    } else write_varint(parents_bytes, 1)

    patches.push(23)
    write_varint(patches, parents_bytes.length)
    for (let x of parents_bytes) patches.push(x)

    // write in patches
    bytes.push(20)
    write_varint(bytes, patches.length)
    for (let b of patches) bytes.push(b)

    //   console.log(bytes);
    return bytes
}

function defrag_dt(doc) {
    let bytes = doc.toBytes()
    doc.free()
    return Doc.fromBytes(bytes, 'server')
}

function OpLog_remote_to_local(doc, frontier) {
    let map = Object.fromEntries(frontier.map((x) => [x, true]))

    let local_version = []

    let max_version = doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)
    for (let i = 0; i <= max_version; i++) {
        if (map[doc.localToRemoteVersion([i])[0].join("-")]) {
            local_version.push(i)
        }
    }

    return frontier.length == local_version.length && new Uint32Array(local_version)
}

function v_eq(v1, v2) {
    return v1.length == v2.length && v1.every((x, i) => x == v2[i])
}

function get_xf_patches(doc, v) {
    let patches = []
    for (let xf of doc.xfSince(v)) {
        patches.push(
            xf.kind == "Ins"
                ? {
                    unit: "text",
                    range: `[${xf.start}:${xf.start}]`,
                    content: xf.content,
                }
                : {
                    unit: "text",
                    range: `[${xf.start}:${xf.end}]`,
                    content: "",
                }
        )
    }
    return relative_to_absolute_patches(patches)
}

function relative_to_absolute_patches(patches) {
    let avl = create_avl_tree((node) => {
        let parent = node.parent
        if (parent.left == node) {
            parent.left_size -= node.left_size + node.size
        } else {
            node.left_size += parent.left_size + parent.size
        }
    })
    avl.root.size = Infinity
    avl.root.left_size = 0

    function resize(node, new_size) {
        if (node.size == new_size) return
        let delta = new_size - node.size
        node.size = new_size
        while (node.parent) {
            if (node.parent.left == node) node.parent.left_size += delta
            node = node.parent
        }
    }

    for (let p of patches) {
        let [start, end] = p.range.match(/\d+/g).map((x) => 1 * x)
        let del = end - start

        let node = avl.root
        while (true) {
            if (start < node.left_size || (node.left && node.content == null && start == node.left_size)) {
                node = node.left
            } else if (start > node.left_size + node.size || (node.content == null && start == node.left_size + node.size)) {
                start -= node.left_size + node.size
                node = node.right
            } else {
                start -= node.left_size
                break
            }
        }

        let remaining = start + del - node.size
        if (remaining < 0) {
            if (node.content == null) {
                if (start > 0) {
                    let x = { size: 0, left_size: 0 }
                    avl.add(node, "left", x)
                    resize(x, start)
                }
                let x = { size: 0, left_size: 0, content: p.content, del }
                avl.add(node, "left", x)
                resize(x, count_code_points(x.content))
                resize(node, node.size - (start + del))
            } else {
                node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content + node.content.slice(codePoints_to_index(node.content, start + del))
                resize(node, count_code_points(node.content))
            }
        } else {
            let next
            let middle_del = 0
            while (remaining >= (next = avl.next(node)).size) {
                remaining -= next.size
                middle_del += next.del ?? next.size
                resize(next, 0)
                avl.del(next)
            }

            if (node.content == null) {
                if (next.content == null) {
                    if (start == 0) {
                        node.content = p.content
                        node.del = node.size + middle_del + remaining
                        resize(node, count_code_points(node.content))
                    } else {
                        let x = {
                            size: 0,
                            left_size: 0,
                            content: p.content,
                            del: node.size - start + middle_del + remaining,
                        }
                        resize(node, start)
                        avl.add(node, "right", x)
                        resize(x, count_code_points(x.content))
                    }
                    resize(next, next.size - remaining)
                } else {
                    next.del += node.size - start + middle_del
                    next.content = p.content + next.content.slice(codePoints_to_index(next.content, remaining))
                    resize(node, start)
                    if (node.size == 0) avl.del(node)
                    resize(next, count_code_points(next.content))
                }
            } else {
                if (next.content == null) {
                    node.del += middle_del + remaining
                    node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content
                    resize(node, count_code_points(node.content))
                    resize(next, next.size - remaining)
                } else {
                    node.del += middle_del + next.del
                    node.content = node.content.slice(0, codePoints_to_index(node.content, start)) + p.content + next.content.slice(codePoints_to_index(next.content, remaining))
                    resize(node, count_code_points(node.content))
                    resize(next, 0)
                    avl.del(next)
                }
            }
        }
    }

    let new_patches = []
    let offset = 0
    let node = avl.root
    while (node.left) node = node.left
    while (node) {
        if (node.content == null) {
            offset += node.size
        } else {
            new_patches.push({
                unit: patches[0].unit,
                range: `[${offset}:${offset + node.del}]`,
                content: node.content,
            })
            offset += node.del
        }

        node = avl.next(node)
    }
    return new_patches
}

function create_avl_tree(on_rotate) {
    let self = { root: { height: 1 } }

    self.calc_height = (node) => {
        node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0)
    }

    self.rechild = (child, new_child) => {
        if (child.parent) {
            if (child.parent.left == child) {
                child.parent.left = new_child
            } else {
                child.parent.right = new_child
            }
        } else {
            self.root = new_child
        }
        if (new_child) new_child.parent = child.parent
    }

    self.rotate = (node) => {
        on_rotate(node)

        let parent = node.parent
        let left = parent.right == node ? "left" : "right"
        let right = parent.right == node ? "right" : "left"

        parent[right] = node[left]
        if (parent[right]) parent[right].parent = parent
        self.calc_height(parent)

        self.rechild(parent, node)
        parent.parent = node

        node[left] = parent
    }

    self.fix_avl = (node) => {
        self.calc_height(node)
        let diff = (node.right?.height ?? 0) - (node.left?.height ?? 0)
        if (Math.abs(diff) >= 2) {
            if (diff > 0) {
                if ((node.right.left?.height ?? 0) > (node.right.right?.height ?? 0)) self.rotate(node.right.left)
                self.rotate((node = node.right))
            } else {
                if ((node.left.right?.height ?? 0) > (node.left.left?.height ?? 0)) self.rotate(node.left.right)
                self.rotate((node = node.left))
            }
            self.fix_avl(node)
        } else if (node.parent) self.fix_avl(node.parent)
    }

    self.add = (node, side, add_me) => {
        let other_side = side == "left" ? "right" : "left"
        add_me.height = 1

        if (node[side]) {
            node = node[side]
            while (node[other_side]) node = node[other_side]
            node[other_side] = add_me
        } else {
            node[side] = add_me
        }
        add_me.parent = node
        self.fix_avl(node)
    }

    self.del = (node) => {
        if (node.left && node.right) {
            let cursor = node.right
            while (cursor.left) cursor = cursor.left
            cursor.left = node.left

            // breaks abstraction
            cursor.left_size = node.left_size
            let y = cursor
            while (y.parent != node) {
                y = y.parent
                y.left_size -= cursor.size
            }

            node.left.parent = cursor
            if (cursor == node.right) {
                self.rechild(node, cursor)
                self.fix_avl(cursor)
            } else {
                let x = cursor.parent
                self.rechild(cursor, cursor.right)
                cursor.right = node.right
                node.right.parent = cursor
                self.rechild(node, cursor)
                self.fix_avl(x)
            }
        } else {
            self.rechild(node, node.left || node.right || null)
            if (node.parent) self.fix_avl(node.parent)
        }
    }

    self.next = (node) => {
        if (node.right) {
            node = node.right
            while (node.left) node = node.left
            return node
        } else {
            while (node.parent && node.parent.right == node) node = node.parent
            return node.parent
        }
    }

    return self
}

function count_code_points(str) {
    let code_points = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) >= 0xD800 && str.charCodeAt(i) <= 0xDBFF) i++;
        code_points++;
    }
    return code_points;
}

function index_to_codePoints(str, index) {
    let i = 0
    let c = 0
    while (i < index && i < str.length) {
        const charCode = str.charCodeAt(i)
        i += (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
        c++
    }
    return c
}

function codePoints_to_index(str, codePoints) {
    let i = 0
    let c = 0
    while (c < codePoints && i < str.length) {
        const charCode = str.charCodeAt(i)
        i += (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
        c++
    }
    return i
}

function encode_filename(filename) {
    // Swap all "!" and "/" characters
    let swapped = filename.replace(/[!/]/g, (match) => (match === "!" ? "/" : "!"))

    // Encode the filename using encodeURIComponent()
    let encoded = encodeURIComponent(swapped)

    return encoded
}

function decode_filename(encodedFilename) {
    // Decode the filename using decodeURIComponent()
    let decoded = decodeURIComponent(encodedFilename)

    // Swap all "/" and "!" characters
    decoded = decoded.replace(/[!/]/g, (match) => (match === "/" ? "!" : "/"))

    return decoded
}

function validate_version_array(x) {
    if (!Array.isArray(x)) throw new Error(`invalid version array: not an array`)
    x.sort()
    for (var xx of x) validate_actor_seq(xx)
}

function validate_actor_seq(x) {
    if (typeof x !== 'string') throw new Error(`invalid actor-seq: not a string`)
    let [actor, seq] = decode_version(x)
    validate_actor(actor)
}

function validate_actor(x) {
    if (typeof x !== 'string') throw new Error(`invalid actor: not a string`)
    if (Buffer.byteLength(x, 'utf8') >= 50) throw new Error(`actor value too long (max 49): ${x}`) // restriction coming from dt
}

function is_valid_actor(x) {
    try {
        validate_actor(x)
        return true
    } catch (e) { }
}

function decode_version(v) {
    let m = v.match(/^(.*)-(\d+)$/s)
    if (!m) throw new Error(`invalid actor-seq version: ${v}`)
    return [m[1], parseInt(m[2])]
}

function validate_patches(patches) {
    if (!Array.isArray(patches)) throw new Error(`invalid patches: not an array`)
    for (let p of patches) validate_patch(p)
}

function validate_patch(x) {
    if (typeof x != 'object') throw new Error(`invalid patch: not an object`)
    if (x.unit && x.unit !== 'text') throw new Error(`invalid patch unit '${x.unit}': only 'text' supported`)
    if (typeof x.range !== 'string') throw new Error(`invalid patch range: must be a string`)
    if (!x.range.match(/^\s*\[\s*\d+\s*:\s*\d+\s*\]\s*$/)) throw new Error(`invalid patch range: ${x.range}`)
    if (typeof x.content !== 'string') throw new Error(`invalid patch content: must be a string`)
}

function createSimpleCache(size) {
    const maxSize = size
    const cache = new Map()

    return {
        put(key, value) {
            if (cache.has(key)) {
                // If the key already exists, update its value and move it to the end
                cache.delete(key)
                cache.set(key, value)
            } else {
                // If the cache is full, remove the oldest entry
                if (cache.size >= maxSize) {
                    const oldestKey = cache.keys().next().value
                    cache.delete(oldestKey)
                }
                // Add the new key-value pair
                cache.set(key, value)
            }
        },

        get(key) {
            if (!cache.has(key)) {
                return null
            }
            // Move the accessed item to the end (most recently used)
            const value = cache.get(key)
            cache.delete(key)
            cache.set(key, value)
            return value
        },
    }
}

function apply_patch(obj, range, content) {

    // Descend down a bunch of objects until we get to the final object
    // The final object can be a slice
    // Set the value in the final object

    var path = range,
        new_stuff = content

    var path_segment = /^(\.?([^\.\[]+))|(\[((-?\d+):)?(-?\d+)\])|\[("(\\"|[^"])*")\]/
    var curr_obj = obj,
        last_obj = null

    // Handle negative indices, like "[-9]" or "[-0]"
    function de_neg (x) {
        return x[0] === '-'
            ? curr_obj.length - parseInt(x.substr(1), 10)
            : parseInt(x, 10)
    }

    // Now iterate through each segment of the range e.g. [3].a.b[3][9]
    while (true) {
        var match = path_segment.exec(path),
            subpath = match ? match[0] : '',
            field = match && match[2],
            slice_start = match && match[5],
            slice_end = match && match[6],
            quoted_field = match && match[7]

        // The field could be expressed as ["nnn"] instead of .nnn
        if (quoted_field) field = JSON.parse(quoted_field)

        slice_start = slice_start && de_neg(slice_start)
        slice_end = slice_end && de_neg(slice_end)

        // console.log('Descending', {curr_obj, path, subpath, field, slice_start, slice_end, last_obj})

        // If it's the final item, set it
        if (path.length === subpath.length) {
            if (!subpath) return new_stuff
            else if (field) {                           // Object
                if (new_stuff === undefined)
                    delete curr_obj[field]              // - Delete a field in object
                else
                    curr_obj[field] = new_stuff         // - Set a field in object
            } else if (typeof curr_obj === 'string') {  // String
                console.assert(typeof new_stuff === 'string')
                if (!slice_start) {slice_start = slice_end; slice_end = slice_end+1}
                if (last_obj) {
                    var s = last_obj[last_field]
                    last_obj[last_field] = (s.slice(0, slice_start)
                                            + new_stuff
                                            + s.slice(slice_end))
                } else
                    return obj.slice(0, slice_start) + new_stuff + obj.slice(slice_end)
            } else                                     // Array
                if (slice_start)                       //  - Array splice
                    [].splice.apply(curr_obj, [slice_start, slice_end-slice_start]
                                    .concat(new_stuff))
            else {                                     //  - Array set
                console.assert(slice_end >= 0, 'Index '+subpath+' is too small')
                console.assert(slice_end <= curr_obj.length - 1,
                               'Index '+subpath+' is too big')
                curr_obj[slice_end] = new_stuff
            }

            return obj
        }

        // Otherwise, descend down the path
        console.assert(!slice_start, 'No splices allowed in middle of path')
        last_obj = curr_obj
        last_field = field || slice_end
        curr_obj = curr_obj[last_field]
        path = path.substr(subpath.length)
    }
}

class RangeSet {
    constructor() {
        this.ranges = []
    }

    add_range(low_inclusive, high_inclusive) {
        if (low_inclusive > high_inclusive) return

        const startIndex = this._bs(mid => this.ranges[mid][1] >= low_inclusive - 1, this.ranges.length, true)
        const endIndex = this._bs(mid => this.ranges[mid][0] <= high_inclusive + 1, -1, false)

        if (startIndex > endIndex) {
            this.ranges.splice(startIndex, 0, [low_inclusive, high_inclusive])
        } else {
            const mergedLow = Math.min(low_inclusive, this.ranges[startIndex][0])
            const mergedHigh = Math.max(high_inclusive, this.ranges[endIndex][1])
            const removeCount = endIndex - startIndex + 1
            this.ranges.splice(startIndex, removeCount, [mergedLow, mergedHigh])
        }
    }

    has(x) {
        var index = this._bs(mid => this.ranges[mid][0] <= x, -1, false)
        return index !== -1 && x <= this.ranges[index][1]
    }

    _bs(condition, defaultR, moveLeft) {
        let low = 0
        let high = this.ranges.length - 1
        let result = defaultR
        
        while (low <= high) {
            const mid = Math.floor((low + high) / 2)
            if (condition(mid)) {
                result = mid
                if (moveLeft) high = mid - 1
                else low = mid + 1
            } else {
                if (moveLeft) low = mid + 1
                else high = mid - 1
            }
        }
        return result
    }
}

function ascii_ify(s) {
    return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function sorted_set_find(arr, val) {
    var left = 0, right = arr.length
    while (left < right) {
        var mid = (left + right) >> 1
        arr[mid] < val ? left = mid + 1 : right = mid
    }
    return left
}

function sorted_set_insert(arr, val) {
    var i = sorted_set_find(arr, val)
    if (arr[i] !== val) arr.splice(i, 0, val)
}

function sorted_set_delete(arr, val) {
    var i = sorted_set_find(arr, val)
    if (arr[i] === val) arr.splice(i, 1)
}

braid_text.get_resource = get_resource

braid_text.encode_filename = encode_filename
braid_text.decode_filename = decode_filename
braid_text.get_files_for_key = get_files_for_key

braid_text.dt_get = dt_get
braid_text.dt_get_patches = dt_get_patches
braid_text.dt_parse = dt_parse
braid_text.dt_get_local_version = dt_get_local_version
braid_text.dt_create_bytes = dt_create_bytes

braid_text.decode_version = decode_version
braid_text.RangeSet = RangeSet

module.exports = braid_text
