
let { Doc } = require("diamond-types-node")
let braidify = require("braid-http").http_server
let fs = require("fs")

let braid_text = {
    db_folder: './braid-text-db'
}

let waiting_puts = 0
let prev_put_p = null

let max_encoded_key_size = 240

braid_text.serve = async (req, res, options = {}) => {
    options = {
        key: req.url.split('?')[0], // Default key
        put_cb: (key, val) => { },  // Default callback when a PUT changes a key
        ...options                  // Override with all options passed in
    }

    // free CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Expose-Headers", "*")

    function my_end(statusCode, x) {
        res.statusCode = statusCode
        res.end(x ?? '')
    }

    let resource = null
    try {
        resource = await get_resource(options.key)

        braidify(req, res)
    } catch (e) {
        return my_end(400, "The server failed to process this request. The error generated was: " + e)
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
        await resource.delete_me()
        return my_end(200)
    }

    if (req.method == "GET" || req.method == "HEAD") {
        if (!req.subscribe) {
            res.setHeader("Accept-Subscribe", "true")

            let x = null
            try {
                x = await braid_text.get(resource, { version: req.version, parents: req.parents })
            } catch (e) {
                return my_end(400, "The server failed to get something. The error generated was: " + e)
            }

            res.setHeader("Version", x.version.map((x) => JSON.stringify(x)).join(", "))

            const buffer = Buffer.from(x.body, "utf8")
            res.setHeader("Content-Length", buffer.length)

            if (req.method === "HEAD") return my_end(200)

            return my_end(200, buffer)
        } else {
            res.setHeader("Editable", "true")
            res.setHeader("Merge-Type", merge_type)
            if (req.method == "HEAD") return my_end(200)

            let options = {
                peer,
                version: req.version,
                parents: req.parents,
                merge_type,
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
                return my_end(400, "The server failed to get something. The error generated was: " + e)
            }
        }
    }

    if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
        if (waiting_puts >= 100) {
            console.log(`The server is busy.`)
            return my_end(503, "The server is busy.")
        }

        waiting_puts++
        console.log(`waiting_puts(after++) = ${waiting_puts}`)

        let my_prev_put_p = prev_put_p
        let done_my_turn = null
        prev_put_p = new Promise(
            (done) =>
            (done_my_turn = (statusCode, x) => {
                waiting_puts--
                console.log(`waiting_puts(after--) = ${waiting_puts}`)
                my_end(statusCode, x)
                done()
            })
        )
        let patches = null
        let ee = null
        try {
            patches = await req.patches()
        } catch (e) { ee = e }
        await my_prev_put_p

        try {
            if (ee) throw ee

            let body = null
            if (patches[0]?.unit === 'everything') {
                body = patches[0].content
                patches = null
            }

            await braid_text.put(resource, { peer, version: req.version, parents: req.parents, patches, body, merge_type })

            options.put_cb(options.key, resource.doc.get())
        } catch (e) {
            console.log(`EEE= ${e}:${e.stack}`)
            // we couldn't apply the version, possibly because we're missing its parents,
            // we want to send a 4XX error, so the client will resend this request later,
            // hopefully after we've received the necessary parents.

            // here are some 4XX error code options..
            //
            // - 425 Too Early
            //     - pros: our message is too early
            //     - cons: associated with some "Early-Data" http thing, which we're not using
            // - 400 Bad Request
            //     - pros: pretty generic
            //     - cons: implies client shouldn't resend as-is
            // - 409 Conflict
            //     - pros: doesn't imply modifications needed
            //     - cons: the message is not conflicting with anything
            // - 412 Precondition Failed
            //     - pros: kindof true.. the precondition of having another version has failed..
            //     - cons: not strictly true, as this code is associated with http's If-Unmodified-Since stuff
            // - 422 Unprocessable Content
            //     - pros: it's true
            //     - cons: implies client shouldn't resend as-is (at least, it says that here: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422)
            // - 428 Precondition Required
            //     - pros: the name sounds right
            //     - cons: typically implies that the request was missing an http conditional field like If-Match. that is to say, it implies that the request is missing a precondition, not that the server is missing a precondition
            return done_my_turn(425, "The server failed to apply this version. The error generated was: " + e)
        }

        return done_my_turn(200)
    }

    throw new Error("unknown")
}

braid_text.get = async (key, options) => {
    if (!options) {
        let x = get_resource.cache?.[key]?.doc.get()
        if (x !== undefined) return x
        // if it doesn't exist on disk, don't create it in this case
        if (!(await get_files_for_key(key)).length) return
        return (await get_resource(key)).doc.get()
    }

    if (options.version) validate_version_array(options.version)
    if (options.parents) validate_version_array(options.parents)

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    if (!options.subscribe) {
        let doc = null
        if (options.version || options.parents) {
            let frontier = {}
            options.version?.forEach((x) => (frontier[x] = true))
            options.parents?.forEach((x) => (frontier[x] = true))

            let local_version = []
            let [agents, versions, parentss] = parseDT([...resource.doc.toBytes()])
            for (let i = 0; i < versions.length; i++) {
                if (frontier[versions[i].join("-")]) {
                    local_version.push(i)
                }
            }
            local_version = new Uint32Array(local_version)

            let after_versions = {}
            let [_, after_versions_array, __] = parseDT([...resource.doc.getPatchSince(local_version)])
            for (let v of after_versions_array) after_versions[v.join("-")] = true

            let new_doc = new Doc()
            let op_runs = resource.doc.getOpsSince([])
            let i = 0
            op_runs.forEach((op_run) => {
                let parents = parentss[i].map((x) => x.join("-"))
                let start = op_run.start
                let end = start + 1
                let content = op_run.content?.[0]

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
                            if (!after_versions[version]) {
                                new_doc.mergeBytes(
                                    OpLog_create_bytes(
                                        version,
                                        parentss[i].map((x) => x.join("-")),
                                        content ? start + (i - base_i) : start,
                                        content?.[0]
                                    )
                                )
                            }
                            if (op_run.content) content = content.slice(1)
                        }
                        content = ""
                    }
                    if (op_run.content) content += op_run.content[j]
                }
            })
            doc = new_doc
        } else doc = resource.doc

        return {
            version: doc.getRemoteVersion().map((x) => x.join("-")),
            body: doc.get()
        }
    } else {
        if (options.merge_type != "dt") {
            let version = resource.doc.getRemoteVersion().map((x) => x.join("-"))
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
            let updates = null

            if (resource.need_defrag) {
                console.log(`doing defrag..`)
                resource.need_defrag = false
                resource.doc = defrag_dt(resource.doc)
            }

            if (!options.parents && !options.version) {
                options.subscribe({
                    version: [],
                    parents: [],
                    body: "",
                })

                updates = OpLog_get_patches(resource.doc.toBytes(), resource.doc.getOpsSince([]))
            } else {
                // Then start the subscription from the parents in options
                let parents = Object.fromEntries((options.parents ? options.parents : options.version).map((x) => [x, true]))

                let local_version = []
                let [agents, versions, parentss] = parseDT([...resource.doc.toBytes()])
                for (let i = 0; i < versions.length; i++) {
                    if (parents[versions[i].join("-")]) local_version.push(i)
                }
                local_version = new Uint32Array(local_version)

                updates = OpLog_get_patches(resource.doc.getPatchSince(local_version), resource.doc.getOpsSince(local_version))
            }

            for (let u of updates) {
                u.version = decode_version(u.version)
                u.version[1] += u.end - u.start - 1
                u.version = u.version.join("-")

                options.subscribe({
                    version: [u.version],
                    parents: u.parents,
                    patches: [{ unit: u.unit, range: u.range, content: u.content }],
                })
            }

            // Output at least *some* data, or else chrome gets confused and
            // thinks the connection failed.  This isn't strictly necessary,
            // but it makes fewer scary errors get printed out in the JS
            // console.
            if (updates.length === 0) options.write?.("\r\n")

            resource.clients.add(options)
        }
    }
}

braid_text.put = async (key, options) => {
    let { version, patches, body, peer } = options

    if (version) validate_version_array(version)
    if (options.parents) validate_version_array(options.parents)
    if (body != null && patches) throw new Error(`cannot have a body and patches`)
    if (body != null && (typeof body !== 'string')) throw new Error(`body must be a string`)
    if (patches) validate_patches(patches)

    let resource = (typeof key == 'string') ? await get_resource(key) : key

    if (body != null) {
        patches = [{
            unit: 'text',
            range: `[0:${count_code_points(resource.doc.get())}]`,
            content: body
        }]
    }

    let og_patches = patches
    patches = patches.map((p) => ({
        ...p,
        range: p.range.match(/\d+/g).map((x) => parseInt(x)),
        content: [...p.content],
    })).sort((a, b) => a.range[0] - b.range[0])

    // validate patch positions
    let max_pos = resource.doc.get().length
    let must_be_at_least = 0
    for (let p of patches) {
        if (p.range[0] < must_be_at_least || p.range[0] > max_pos) throw new Error(`invalid patch range position: ${p.range[0]}`)
        if (p.range[1] < p.range[0] || p.range[1] > max_pos) throw new Error(`invalid patch range position: ${p.range[1]}`)
        must_be_at_least = p.range[1]
    }

    let change_count = patches.reduce((a, b) => a + b.content.length + (b.range[1] - b.range[0]), 0)

    let og_v = version?.[0] || `${(is_valid_actor(peer) && peer) || Math.random().toString(36).slice(2, 7)}-${change_count - 1}`

    // reduce the version sequence by the number of char-edits
    let v = decode_version(og_v)

    // validate version: make sure we haven't seen it already
    if (v[1] <= (resource.actor_seqs[v[0]] ?? -1)) throw new Error(`invalid version: already processed`)
    resource.actor_seqs[v[0]] = v[1]

    v = `${v[0]}-${v[1] + 1 - change_count}`

    let parents = resource.doc.getRemoteVersion().map((x) => x.join("-"))
    let og_parents = options.parents || parents
    let ps = og_parents

    let v_before = resource.doc.getLocalVersion()

    let bytes = []

    let offset = 0
    for (let p of patches) {
        // delete
        for (let i = p.range[0]; i < p.range[1]; i++) {
            bytes.push(OpLog_create_bytes(v, ps, p.range[1] - 1 + offset, null))
            offset--
            ps = [v]
            v = decode_version(v)
            v = `${v[0]}-${v[1] + 1}`
        }
        // insert
        for (let i = 0; i < p.content?.length ?? 0; i++) {
            let c = p.content[i]
            bytes.push(OpLog_create_bytes(v, ps, p.range[1] + offset, c))
            offset++
            ps = [v]
            v = decode_version(v)
            v = `${v[0]}-${v[1] + 1}`
        }
    }

    for (let b of bytes) resource.doc.mergeBytes(b)

    resource.need_defrag = true

    let v_after = resource.doc.getLocalVersion()
    if (JSON.stringify(v_before) === JSON.stringify(v_after)) {
        console.log(`we got a version we already had: ${v_before}`)
        return
    }

    if (options.merge_type != "dt") {
        patches = get_xf_patches(resource.doc, v_before)
        console.log(JSON.stringify({ patches }))

        let version = resource.doc.getRemoteVersion().map((x) => x.join("-"))

        for (let client of resource.simpleton_clients) {
            if (client.peer == peer) {
                client.my_last_seen_version = [og_v]
            }

            function set_timeout(time_override) {
                if (client.my_timeout) clearTimeout(client.my_timeout)
                client.my_timeout = setTimeout(() => {
                    let version = resource.doc.getRemoteVersion().map((x) => x.join("-"))
                    let x = { version }
                    x.parents = client.my_last_seen_version

                    console.log("rebasing after timeout.. ")
                    console.log("    client.my_unused_version_count = " + client.my_unused_version_count)
                    x.patches = get_xf_patches(resource.doc, OpLog_remote_to_local(resource.doc, client.my_last_seen_version))

                    console.log(`sending from rebase: ${JSON.stringify(x)}`)
                    client.subscribe(x)
                    client.my_last_sent_version = x.version

                    delete client.my_timeout
                }, time_override ?? Math.min(3000, 23 * Math.pow(1.5, client.my_unused_version_count - 1)))
            }

            if (client.my_timeout) {
                if (client.peer == peer) {
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
            if (client.peer == peer) {
                if (!v_eq(client.my_last_sent_version, og_parents)) {
                    client.my_unused_version_count = (client.my_unused_version_count ?? 0) + 1
                    set_timeout()
                    continue
                } else {
                    delete client.my_unused_version_count
                }

                x.parents = options.version
                if (!v_eq(version, options.version)) {
                    console.log("rebasing..")
                    x.patches = get_xf_patches(resource.doc, OpLog_remote_to_local(resource.doc, [og_v]))
                } else {
                    // this client already has this version,
                    // so let's pretend to send it back, but not
                    console.log(`not reflecting back to simpleton`)
                    client.my_last_sent_version = x.version
                    continue
                }
            } else {
                x.parents = parents
                x.patches = patches
            }
            console.log(`sending: ${JSON.stringify(x)}`)
            client.subscribe(x)
            client.my_last_sent_version = x.version
        }
    } else {
        if (resource.simpleton_clients.size) {
            let version = resource.doc.getRemoteVersion().map((x) => x.join("-"))
            patches = get_xf_patches(resource.doc, v_before)
            let x = { version, parents, patches }
            console.log(`sending: ${JSON.stringify(x)}`)
            for (let client of resource.simpleton_clients) {
                if (client.my_timeout) continue
                client.subscribe(x)
                client.my_last_sent_version = x.version
            }
        }
    }

    let x = {
        version: [og_v],
        parents: og_parents,
        patches: og_patches,
    }
    for (let client of resource.clients) {
        if (client.peer != peer) client.subscribe(x)
    }

    await resource.db_delta(resource.doc.getPatchSince(v_before))
}

braid_text.list = async () => {
    try {
        if (braid_text.db_folder) {
            await db_folder_init()
            var pages = new Set()
            for (let x of await require('fs').promises.readdir(braid_text.db_folder)) pages.add(decode_filename(x.replace(/\.\w+$/, '')))
            return [...pages.keys()]
        } else return Object.keys(get_resource.cache)
    } catch (e) { return [] }
}

async function get_resource(key) {
    let cache = get_resource.cache || (get_resource.cache = {})
    if (cache[key]) return cache[key]

    let resource = {}
    resource.clients = new Set()
    resource.simpleton_clients = new Set()

    resource.doc = new Doc("server")

    let { change, delete_me } = braid_text.db_folder
        ? await file_sync(key,
            (bytes) => resource.doc.mergeBytes(bytes),
            () => resource.doc.toBytes())
        : { change: () => { }, delete_me: () => { } }

    resource.db_delta = change

    resource.doc = defrag_dt(resource.doc)
    resource.need_defrag = false

    resource.actor_seqs = {}
    let max_version = resource.doc.getLocalVersion()[0] ?? -1
    for (let i = 0; i <= max_version; i++) {
        let v = resource.doc.localToRemoteVersion([i])[0]
        resource.actor_seqs[v[0]] = Math.max(v[1], resource.actor_seqs[v[0]] ?? -1)
    }

    resource.delete_me = () => {
        delete_me()
        delete cache[key]
    }

    return (cache[key] = resource)
}

async function db_folder_init() {
    console.log('__!')
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
                console.log(`deleting: ${braid_text.db_folder}/${x}`)
                await fs.promises.unlink(`${braid_text.db_folder}/${x}`)
            }
        }
        if (Object.keys(convert_us).length) {
            for (let x of await fs.promises.readdir(braid_text.db_folder)) {
                let [_, k, num] = x.match(/^(.*)\.(\d+)$/s)
                if (!convert_us[k]) continue
                console.log(`renaming: ${braid_text.db_folder}/${x} -> ${braid_text.db_folder}/${convert_us[k]}.${num}`)
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
            console.log(`trying to process file: ${filename}`)
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

    return {
        change: async (bytes) => {
            currentSize += bytes.length + 4 // we account for the extra 4 bytes for uint32
            const filename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
            if (currentSize < threshold) {
                console.log(`appending to db..`)

                let buffer = Buffer.allocUnsafe(4)
                buffer.writeUInt32LE(bytes.length, 0)
                await fs.promises.appendFile(filename, buffer)
                await fs.promises.appendFile(filename, bytes)

                console.log("wrote to : " + filename)
            } else {
                try {
                    console.log(`starting new db..`)

                    currentNumber++
                    const init = get_init()
                    const buffer = Buffer.allocUnsafe(4)
                    buffer.writeUInt32LE(init.length, 0)

                    const newFilename = `${braid_text.db_folder}/${encoded}.${currentNumber}`
                    await fs.promises.writeFile(newFilename, buffer)
                    await fs.promises.appendFile(newFilename, init)

                    console.log("wrote to : " + newFilename)

                    currentSize = 4 + init.length
                    threshold = currentSize * 10
                    try {
                        await fs.promises.unlink(filename)
                    } catch (e) { }
                } catch (e) {
                    console.log(`e = ${e.stack}`)
                }
            }
        },
        delete_me: async () => {
            await Promise.all(
                (
                    await get_files_for_key(key)
                ).map((file) => {
                    return new Promise((resolve, reject) => {
                        fs.unlink(file, (err) => {
                            if (err) {
                                console.error(`Error deleting file: ${file}`)
                                reject(err)
                            } else {
                                console.log(`Deleted file: ${file}`)
                                resolve()
                            }
                        })
                    })
                })
            )
        },
    }
}

//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////

function defrag_dt(doc) {
    let fresh_doc = new Doc("server")
    fresh_doc.mergeBytes(doc.toBytes())
    return fresh_doc
}

function OpLog_get_patches(bytes, op_runs) {
    //   console.log(`op_runs = `, op_runs);

    let [agents, versions, parentss] = parseDT([...bytes])

    //   console.log(JSON.stringify({agents, versions, parentss}, null, 4))

    let i = 0
    let patches = []
    op_runs.forEach((op_run) => {
        let version = versions[i].join("-")
        let parents = parentss[i].map((x) => x.join("-"))
        let start = op_run.start
        let end = start + 1
        if (op_run.content) op_run.content = [...op_run.content]
        let content = op_run.content?.[0]
        let len = op_run.end - op_run.start
        for (let j = 1; j <= len; j++) {
            let I = i + j
            if (
                j == len ||
                parentss[I].length != 1 ||
                parentss[I][0][0] != versions[I - 1][0] ||
                parentss[I][0][1] != versions[I - 1][1] ||
                versions[I][0] != versions[I - 1][0] ||
                versions[I][1] != versions[I - 1][1] + 1
            ) {
                patches.push({
                    version,
                    parents,
                    unit: "text",
                    range: content ? `[${start}:${start}]` : `[${start}:${end}]`,
                    content: content ?? "",
                    start,
                    end,
                })
                if (j == len) break
                version = versions[I].join("-")
                parents = parentss[I].map((x) => x.join("-"))
                start = op_run.start + j
                content = ""
            }
            end++
            if (op_run.content) content += op_run.content[j]
        }
        i += len
    })
    return patches
}

function parseDT(byte_array) {
    if (new TextDecoder().decode(new Uint8Array(byte_array.splice(0, 8))) !== "DMNDTYPS") throw new Error("dt parse error, expected DMNDTYPS")

    if (byte_array.shift() != 0) throw new Error("dt parse error, expected version 0")

    let agents = []
    let versions = []
    let parentss = []

    while (byte_array.length) {
        let id = byte_array.shift()
        let len = read_varint(byte_array)
        if (id == 1) {
        } else if (id == 3) {
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                agents.push(read_string(byte_array))
            }
        } else if (id == 20) {
        } else if (id == 21) {
            let seqs = {}
            let goal = byte_array.length - len
            while (byte_array.length > goal) {
                let part0 = read_varint(byte_array)
                let has_jump = part0 & 1
                let agent_i = (part0 >> 1) - 1
                let run_length = read_varint(byte_array)
                let jump = 0
                if (has_jump) {
                    let part2 = read_varint(byte_array)
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
                let run_len = read_varint(byte_array)

                let parents = []
                let has_more = 1
                while (has_more) {
                    let x = read_varint(byte_array)
                    let is_foreign = 0x1 & x
                    has_more = 0x2 & x
                    let num = x >> 2

                    if (x == 1) {
                        // no parents (e.g. parent is "root")
                    } else if (!is_foreign) {
                        parents.push(versions[count - num])
                    } else {
                        parents.push([agents[num - 1], read_varint(byte_array)])
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

    function read_string(byte_array) {
        return new TextDecoder().decode(new Uint8Array(byte_array.splice(0, read_varint(byte_array))))
    }

    function read_varint(byte_array) {
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

    return [agents, versions, parentss]
}

function OpLog_create_bytes(version, parents, pos, ins) {
    // console.log(`args = ${JSON.stringify({ version, parents, pos, ins }, null, 4)}`)

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
        byte_array.push(...str_bytes)
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
    file_info.push(...agent_names)

    bytes.push(1)
    write_varint(bytes, file_info.length)
    bytes.push(...file_info)

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
        branch.push(...frontier)
    }

    bytes.push(10)
    write_varint(bytes, branch.length)
    bytes.push(...branch)

    let patches = []

    if (ins) {
        let inserted_content_bytes = []

        inserted_content_bytes.push(0) // ins (not del, which is 1)

        inserted_content_bytes.push(13) // "content" enum (rather than compressed)

        let encoder = new TextEncoder()
        let utf8Bytes = encoder.encode(ins)

        inserted_content_bytes.push(1 + utf8Bytes.length) // length of content chunk
        inserted_content_bytes.push(4) // "plain text" enum

        for (let b of utf8Bytes) inserted_content_bytes.push(b) // actual text

        inserted_content_bytes.push(25) // "known" enum
        inserted_content_bytes.push(1) // length of "known" chunk
        inserted_content_bytes.push(3) // content of length 1, and we "know" it

        patches.push(24)
        write_varint(patches, inserted_content_bytes.length)
        patches.push(...inserted_content_bytes)
    }

    // write in the version
    let version_bytes = []

    let [agent, seq] = version
    let agent_i = agent_to_i[agent]
    let jump = seq

    write_varint(version_bytes, ((agent_i + 1) << 1) | (jump != 0 ? 1 : 0))
    write_varint(version_bytes, 1)
    if (jump) write_varint(version_bytes, jump << 1)

    patches.push(21)
    write_varint(patches, version_bytes.length)
    patches.push(...version_bytes)

    // write in "op" bytes (some encoding of position)
    let op_bytes = []

    write_varint(op_bytes, (pos << 4) | (pos ? 2 : 0) | (ins ? 0 : 4))

    patches.push(22)
    write_varint(patches, op_bytes.length)
    patches.push(...op_bytes)

    // write in parents
    let parents_bytes = []

    write_varint(parents_bytes, 1)

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
    patches.push(...parents_bytes)

    // write in patches
    bytes.push(20)
    write_varint(bytes, patches.length)
    bytes.push(...patches)

    //   console.log(bytes);
    return bytes
}

function OpLog_remote_to_local(doc, frontier) {
    let map = Object.fromEntries(frontier.map((x) => [x, true]))

    let local_version = []

    let max_version = doc.getLocalVersion()[0] ?? -1
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
    for (xx of x) validate_actor_seq(xx)
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
    } catch (e) {}
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

module.exports = braid_text
