
let { Doc, OpLog, Branch } = require("@braid.org/diamond-types-node")
let {http_server: braidify, fetch: braid_fetch} = require("braid-http")
let fs = require("fs")

let Y = null
try { Y = require('yjs') } catch(e) {}


var all_subscriptions = new Set()

// Converts this to a forced serialized function, that is only called one at a
// time, and in order.  Even if the inner `fun` is async, it will guarantee
// that the prior one is always finished before the next one is called.
//
// We use this to guarantee that updates are all sent in order, with the prior
// one sent before the next one begins to send.
function one_at_a_time(fun) {
    var queue = Promise.resolve()
    return (message) => queue = queue.then(() => fun(message))
}

function create_braid_text() {
    let braid_text = {
        verbose: false,
        db_folder: './braid-text-db',
        length_cache_size: 10,
        meta_file_save_period_ms: 1000,
        debug_sync_checks: false,
        simpletonSetTimeout: setTimeout,   // Can be customized for fuzz testing
        cache: {}
    }

    function require_yjs() {
        if (!Y) throw new Error('yjs is not installed. Install it with: npm install yjs')
        return Y
    }

    braid_text.end_all_subscriptions = function() {
        var subs = [...all_subscriptions]
        for (var res of subs) res.end()
    }

    let waiting_puts = 0

    let max_encoded_key_size = 240

    // Bidirectional sync between a local resource and a remote server.
    // Keeps them in sync by forwarding DT updates in both directions.
    // Reconnects automatically on disconnect.
    braid_text.sync = async (local_key, remote_url, options = {}) => {
        if (!options.merge_type) options.merge_type = 'dt'

        // ── Setup: identify local vs remote, prepare headers ──

        if ((local_key instanceof URL) === (remote_url instanceof URL))
            throw new Error(`one parameter should be local string key, and the other a remote URL object`)

        // Normalize so local_key is the string, remote_url is the URL
        if (local_key instanceof URL) { var swap = local_key; local_key = remote_url; remote_url = swap }

        // Split caller's headers into GET headers (Accept) vs PUT headers (Content-Type)
        var content_type
        var get_headers = {}
        var put_headers = {}
        if (options.headers) {
            for (var [k, v] of Object.entries(options.headers)) {
                var lk = k.toLowerCase()
                if (lk === 'accept' || lk === 'content-type')
                    content_type = v
                else {
                    get_headers[k] = v
                    put_headers[k] = v
                }
            }
        }
        if (content_type) {
            get_headers['Accept'] = content_type
            put_headers['Content-Type'] = content_type
        }

        // ── Load the local resource and initialize the fork point ──
        //
        // The fork point is the most recent set of versions that both local
        // and remote are known to share.  It's persisted in resource meta
        // so reconnections don't start from scratch.

        var resource = (typeof local_key == 'string') ? await get_resource(local_key) : local_key
        await ensure_dt_exists(resource)

        if (!resource.meta.fork_point && options.fork_point_hint) {
            resource.meta.fork_point = options.fork_point_hint
            resource.save_meta()
        }

        // When we get an ackowledgement that a remote server has a version
        // that we have:
        //
        //   - In a PUT acknowledgement
        //   - Or a GET response
        //
        // ...then we extend our known fork point "frontier" to include that
        // version.
        function extend_fork_point(update) {

            // Given a version frontier, incorporate a new update (version +
            // parents) to compute the new frontier.  Walks the DT version DAG
            // if needed.
            function extend_frontier(frontier, version, parents) {
                var frontier_set = new Set(frontier)
                // Fast path: if the frontier contains all the update's parents,
                // just swap them out for the new version
                if (parents.length &&
                    parents.every(p => frontier_set.has(p))) {
                    parents.forEach(p => frontier_set.delete(p))
                    for (var event of version) frontier_set.add(event)
                    frontier = [...frontier_set.values()]
                } else {
                    // Slow path: walk the full DT history to compute the frontier
                    var looking_for = frontier_set
                    for (var event of version) looking_for.add(event)

                    frontier = []
                    var shadow = new Set()

                    var bytes = resource.dt.doc.toBytes()
                    var [_, events, parentss] = braid_text.dt_parse([...bytes])
                    for (var i = events.length - 1; i >= 0 && looking_for.size; i--) {
                        var e = events[i].join('-')
                        if (looking_for.has(e)) {
                            looking_for.delete(e)
                            if (!shadow.has(e)) frontier.push(e)
                            shadow.add(e)
                        }
                        if (shadow.has(e))
                            parentss[i].forEach(p => shadow.add(p.join('-')))
                    }
                }
                return frontier.sort()
            }

            resource.meta.fork_point = extend_frontier(resource.meta.fork_point,
                                                       update.version,
                                                       update.parents)
            resource.save_meta()
        }

        // ── Reconnection wrapper ──
        //
        // Everything below runs inside reconnector(), which retries
        // the entire connection on failure with backoff.

        reconnector(options.signal, (_e, count) => {
            var delay = Math.min(count, 3) * 1000
            console.log(`disconnected from ${remote_url}, retrying in ${delay}ms`)
            return delay
        }, async (signal, handle_error) => {
            if (options.on_pre_connect) await options.on_pre_connect()
            if (signal.aborted) return

            try {
                // ── Find the fork point ──
                //
                // The fork point tells us where to start syncing from.
                // First check if the remote still has our saved fork point.
                // If not, binary search through local history to find the
                // latest version the remote recognizes.

                async function check_version(version) {
                    var r = await braid_fetch(remote_url.href, {
                        signal, method: 'HEAD', version, headers: get_headers
                    })
                    if (signal.aborted) return
                    if (!r.ok && r.status !== 309 && r.status !== 404 && r.status !== 500)
                        throw new Error(`unexpected HEAD status: ${r.status}`)
                    return r.ok
                }

                if (resource.meta.fork_point &&
                    !(await check_version(resource.meta.fork_point))) {
                    if (signal.aborted) return
                    resource.meta.fork_point = null
                    resource.save_meta()
                }
                if (signal.aborted) return

                if (!resource.meta.fork_point) {
                    // Binary search through local DT history
                    var bytes = resource.dt.doc.toBytes()
                    var [_, events, __] = braid_text.dt_parse([...bytes])
                    events = events.map(x => x.join('-'))

                    var min = -1
                    var max = events.length
                    while (min + 1 < max) {
                        var i = Math.floor((min + max) / 2)
                        var version = [events[i]]
                        if (await check_version(version)) {
                            if (signal.aborted) return
                            min = i
                            resource.meta.fork_point = version
                        } else max = i
                    }
                }

                // ── Local → Remote ──
                //
                // Subscribe to local changes (history since fork_point,
                // then live updates) and forward each one to the remote
                // server via PUT.  Up to 10 PUTs in flight for throughput.

                var local_updates = []
                var in_flight = 0
                var max_in_flight = 10

                // PUT a single update to the remote server.
                // Extends the fork point on success so the next
                // reconnection starts from where we left off.
                async function send_to_remote(update) {
                    var {response} = await braid_text.put(remote_url, {
                        ...update,
                        signal,
                        dont_retry: true,
                        peer: options.peer,
                        headers: put_headers,
                    })
                    if (signal.aborted) return

                    if (response.ok)
                        extend_fork_point(update)
                    else if (response.status === 401 || response.status === 403)
                        await options.on_unauthorized?.()
                    else
                        throw new Error('failed to PUT: ' + response.status)
                }

                // Forward pending local updates to the remote,
                // up to max_in_flight concurrent PUTs.
                // When each PUT completes, check for more work.
                function send_local_updates() {
                    if (signal.aborted) return
                    while (local_updates.length && in_flight < max_in_flight) {
                        var update = local_updates.shift()
                        if (!update.version?.length) continue
                        in_flight++
                        send_to_remote(update).then(() => {
                            if (signal.aborted) return
                            in_flight--
                            if (local_updates.length) send_local_updates()
                        }).catch(handle_error)
                    }
                }

                braid_text.get(local_key, {
                    signal,
                    merge_type: 'dt',
                    peer: options.peer,
                    ...resource.meta.fork_point && {parents: resource.meta.fork_point},
                    subscribe: update => {
                        if (signal.aborted) return
                        if (update.version?.length) {
                            local_updates.push(update)
                            send_local_updates()
                        }
                    }
                })

                // ── Remote → Local ──
                //
                // Subscribe to remote changes and apply them locally via .put().
                // Requests DT binary encoding for efficiency.

                var remote_current_version = null
                var remote_status = null

                await braid_text.get(remote_url, {
                    signal,
                    dont_retry: true,
                    headers: { ...get_headers, 'Merge-Type': 'dt', 'accept-encoding': 'updates(dt)' },
                    parents: resource.meta.fork_point,
                    peer: options.peer,
                    heartbeats: 120,

                    on_response: res => {
                        remote_status = res.status
                        remote_current_version = res.headers.get('current-version')
                        options.on_res?.(res)
                    },

                    subscribe: async update => {
                        if (signal.aborted) return

                        if (update.extra_headers?.encoding === 'dt') {
                            // DT binary: apply directly
                            await braid_text.put(local_key, {
                                body: update.body,
                                transfer_encoding: 'dt',
                                peer: options.peer
                            })
                            if (signal.aborted) return
                            if (remote_current_version) extend_fork_point({
                                version: JSON.parse(`[${remote_current_version}]`),
                                parents: resource.meta.fork_point || []
                            })
                        } else {
                            // Text patches: forward as-is
                            if (options.peer) update.peer = options.peer
                            await braid_text.put(local_key, update)
                            if (signal.aborted) return
                            if (update.version) extend_fork_point(update)
                        }
                    },
                    on_error: e => {
                        options.on_disconnect?.()
                        handle_error(e)
                    }
                })
                if (signal.aborted) return

                // If remote returned 404, reconnect with backoff
                // (the resource might be created later by our local→remote PUTs)
                if (remote_status === 404) {
                    return handle_error(new Error('remote returned 404'))
                }
            } catch (e) { handle_error(e) }
        })
    }

    braid_text.serve = async (req, res, options = {}) => {
        options = {
            key: req.url.split('?')[0],
            put_cb: (key, val, params) => { },
            ...options
        }

        // ── Setup: prepare the response and load the resource ──

        if (braid_text.cors !== false) braid_text.free_cors(res)

        function my_end(statusCode, x, statusText, headers) {
            res.writeHead(statusCode, statusText, headers)
            res.end(x ?? '')
        }

        var resource = null
        try {
            resource = await get_resource(options.key)

            // Add braid protocol support to the req/res objects
            braidify(req, res)
            if (res.is_multiplexer) return

            if (req.version) req.version.sort()
            if (req.parents) req.parents.sort()
        } catch (e) {
            return my_end(500, 'The server failed to process this request. The error generated was: ' + e)
        }

        // ── Cursors get their own content-type and are handled independently ──
        if (await handle_cursors(resource, req, res)) return

        // ── Classify the request ──

        var peer = req.headers['peer'],
            merge_type = req.headers['merge-type'] || 'simpleton'
        if (merge_type !== 'simpleton' && merge_type !== 'dt' && merge_type !== 'yjs')
            return my_end(400, `Unknown merge type: ${merge_type}`)

        var is_read  = req.method === 'GET' || req.method === 'HEAD',
            is_write = req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH',
            is_head  = req.method === 'HEAD'

        // ── Ensure the response is labeled as utf-8 text ──

        if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'text/plain')
        var ct = res.getHeader('Content-Type'),
            ct_parts = ct.split(';').map(p => p.trim())
        var charset = ct_parts.find(p => p.toLowerCase().startsWith('charset='))
        if (!charset)
            res.setHeader('Content-Type', `${ct}; charset=utf-8`)
        else if (charset.toLowerCase() !== 'charset=utf-8')
            res.setHeader('Content-Type', ct_parts
                          .map(p => p.toLowerCase().startsWith('charset=') ? 'charset=utf-8' : p)
                          .join('; '))

        // ── Handle simple methods that don't need further processing ──

        if (req.method === 'OPTIONS') return my_end(200)
        if (req.method === 'DELETE') {
            await braid_text.delete(resource)
            return my_end(200)
        }

        var current_version = () => ascii_ify(
            resource.version.map(x => JSON.stringify(x)).join(', '))

        // ── Read state (with GET or HEAD) ──
        if (is_read) {
            // Validate requested versions exist
            var unknowns = []
            for (var event of (req.version || []).concat(req.parents || [])) {
                var [actor, seq] = decode_version(event)
                if (!resource.dt?.known_versions[actor]?.has(seq))
                    unknowns.push(event)
            }
            if (unknowns.length)
                return my_end(309, '', 'Version Unknown Here', {
                    Version: ascii_ify(unknowns.map(e => JSON.stringify(e)).join(', '))
                })

            var has_parents = Array.isArray(req.parents)
            var has_version = Array.isArray(req.version)

            if (req.subscribe && has_version)
                return my_end(400, 'Version header is not allowed with Subscribe — use Parents instead')

            var getting = {
                subscribe: !!req.subscribe,
                history:   (has_parents && v_eq(req.parents, resource.version)) ? false
                    : has_parents ? 'since-parents'
                    : (req.subscribe || req.parents || req.headers['accept-transfer-encoding']) ? 'up-to-version'
                    : false,
                transfer_encoding: req.headers['accept-transfer-encoding'],
            }
            getting.single_snapshot = !getting.subscribe && !getting.history

            // Response headers
            if (getting.subscribe && !res.hasHeader('editable'))
                // BUG: This shouldn't be guarded behind "subscribe" because
                // clients can also edit text without subscribing to it, just
                // by doing PUTs and polling to see the updates to the state.
                //
                // But this should only be editable if the client can actually
                // edit it, and so I am guessing that whoever wrote this might
                // have been actually trying to guard something that happens
                // to correlate with subscriptions, which is bogus, but needs
                // to be thought through and fixed.
                res.setHeader('Editable', 'true')
            res.setHeader('Current-Version', current_version())
            res.setHeader('Merge-Type', merge_type)
            res.setHeader('Accept-Subscribe', 'true')

            // HEAD: headers only, no body needed
            if (is_head) {
                // Always include the version of what would be returned
                if (!getting.history)
                    res.setHeader('Version', current_version())
                return my_end(200)
            }

            if (!getting.subscribe) {
                // ── One-shot read ──
                try {
                    var result = await braid_text.get(resource, {
                        version: req.version,
                        parents: req.parents,
                        transfer_encoding: getting.transfer_encoding,
                        full_response: true,
                    })
                } catch (e) {
                    return my_end(500, 'The server at ' + resource + ' failed: ' + e)
                }

                if (getting.transfer_encoding === 'dt') {
                    res.setHeader('X-Transfer-Encoding', 'dt')
                    res.setHeader('Content-Length', result.body.length)
                    return my_end(209, result.body, 'Multiresponse')
                } else if (Array.isArray(result)) {
                    // Range of history: send as 209 Multiresponse
                    res.startSubscription()
                    for (var u of result)
                        res.sendVersion({
                            version: [u.version],
                            parents: u.parents,
                            patches: [{ unit: u.unit, range: u.range, content: u.content }],
                        })
                    return res.end()
                } else {
                    res.setHeader('Version', ascii_ify(result.version
                                                       .map(v => JSON.stringify(v))
                                                       .join(', ')))
                    var buffer = Buffer.from(result.body, 'utf8')
                    res.setHeader('Repr-Digest', get_digest(buffer))
                    res.setHeader('Content-Length', buffer.length)
                    return my_end(200, buffer)
                }
            } else {
                // ── Subscribe ──
                all_subscriptions.add(res)
                var aborter = new AbortController()
                res.startSubscription({
                    onClose: () => {
                        all_subscriptions.delete(res)
                        aborter.abort()
                    }
                })

                try {
                    await braid_text.get(resource, {
                        peer,
                        version: req.version,
                        parents: req.parents,
                        merge_type,
                        signal: aborter.signal,
                        accept_encoding:
                            req.headers['x-accept-encoding'] ?? req.headers['accept-encoding'],
                        subscribe: update => {
                            // Add digest for integrity checking on the client
                            if (update.version && v_eq(update.version, resource.version))
                                update['Repr-Digest'] = get_digest(resource.val)

                            // Collapse single-element patches array for HTTP
                            if (update.patches && update.patches.length === 1) {
                                update.patch = update.patches[0]
                                delete update.patches
                            }
                            res.sendVersion(update)
                        },
                    })
                    // Ensure headers are sent even if .get() didn't send
                    // any initial data (e.g. subscribe when already current)
                    res.flushHeaders()
                } catch (e) {
                    return my_end(500, 'The server failed to get something. The error generated was: ' + e)
                }
                return
            }
        }

        // ── Write (PUT / POST / PATCH) ──
        if (is_write) {
            if (waiting_puts >= 100)
                return my_end(503, 'The server is busy.')

            waiting_puts++
            var done_my_turn = (statusCode, x, statusText, headers) => {
                waiting_puts--
                my_end(statusCode, x, statusText, headers)
            }

            try {
                // Parse patches from request body
                var patches = await req.patches()
                for (var p of patches) p.content = p.content_text

                var body = null
                if (patches[0]?.unit === 'everything') {
                    body = patches[0].content
                    patches = null
                }

                // Wait for parent versions to arrive (if needed)
                if (req.parents) {
                    await ensure_dt_exists(resource)
                    await wait_for_events(
                        options.key, req.parents,
                        resource.dt.known_versions,
                        body != null ? body.length :
                            patches.reduce((a, b) => a + b.range.length + b.content.length, 0),
                        options.recv_buffer_max_time,
                        options.recv_buffer_max_space)

                    var unknowns = []
                    for (var event of req.parents) {
                        var [actor, seq] = decode_version(event)
                        if (!resource.dt.known_versions[actor]?.has(seq))
                            unknowns.push(event)
                    }
                    if (unknowns.length)
                        return done_my_turn(309, '', 'Version Unknown Here', {
                            Version: ascii_ify(unknowns.map(e => JSON.stringify(e)).join(', ')),
                            'Retry-After': '1'
                        })
                }

                // Apply the edit
                var old_val = resource.val
                var old_version = resource.version
                var put_patches = patches?.map(p => ({
                    unit: p.unit, range: p.range, content: p.content
                })) || null

                var {dt: {change_count}} = await braid_text.put(resource, {
                    peer, version: req.version, parents: req.parents,
                    patches, body, merge_type
                })

                // Verify Repr-Digest if present
                if (req.headers['repr-digest'] &&
                    v_eq(req.version, resource.version) &&
                    req.headers['repr-digest'] !== get_digest(resource.val))
                    return done_my_turn(550, 'repr-digest mismatch!')

                if (req.version?.length)
                    got_event(options.key, req.version[0], change_count)

                res.setHeader('Version', current_version())

                options.put_cb(options.key, resource.val, {
                    old_val, patches: put_patches,
                    version: resource.version, parents: old_version
                })
            } catch (e) {
                console.log(`${req.method} ERROR: ${e.stack}`)
                return done_my_turn(500, 'The server failed to apply this version. The error generated was: ' + e)
            }

            return done_my_turn(200)
        }

        throw new Error('unknown method: ' + req.method)
    }

    braid_text.delete = async (key, options) => {
        if (!options) options = {}

        // Handle URL - make a DELETE request
        if (key instanceof URL) {
            var params = {
                method: 'DELETE',
                signal: options.signal,
            }
            for (var x of ['headers', 'peer'])
                if (options[x] != null) params[x] = options[x]

            return await braid_fetch(key.href, params)
        }

        // Accept either a key string or a resource object
        let resource = (typeof key == 'string') ? await get_resource(key) : key
        await resource.delete()
    }

    // Fetch from a remote braid-text server via HTTP
    async function get_remote(url, options) {
        if (!options) options = {}

        var params = {
            signal: options.signal,
            subscribe: !!options.subscribe,
            heartbeats: options.heartbeats ?? 120,
            heartbeat_cb: options.heartbeat_cb
        }
        if (!options.dont_retry)
            params.retry = (res) => res.status !== 404

        for (var x of ['headers', 'parents', 'version', 'peer'])
            if (options[x] != null) params[x] = options[x]

        var res = await braid_fetch(url.href, params)

        if (options.on_response) options.on_response(res)

        if (res.status === 404) return ''

        if (options.subscribe) {
            res.subscribe(async update => {
                // Convert binary to text, except for dt-encoded blobs
                // which are passed through as-is for .sync() to handle
                if (update.extra_headers?.encoding !== 'dt') {
                    update.body = update.body_text
                    if (update.patches)
                        for (var p of update.patches) p.content = p.content_text
                }
                await options.subscribe(update)
            }, e => options.on_error?.(e))
        } else return await res.text()
    }

    braid_text.get = async (key, options) => {
        if (options && options.version) {
            validate_version_array(options.version)
            options.version.sort()
        }
        if (options && options.parents) {
            validate_version_array(options.parents)
            options.parents.sort()
        }

        if (key instanceof URL) return await get_remote(key, options)

        if (!options) options = {}

        var resource = (typeof key == 'string') ? await get_resource(key) : key
        var version = resource.version
        var merge_type = options.range_unit === 'yjs-text' ? 'yjs'
            : (options.merge_type || 'simpleton')
        var has_parents = Array.isArray(options.parents)
        var has_version = Array.isArray(options.version)

        if (options.subscribe && has_version)
            throw new Error('version is not allowed with subscribe — use parents instead')

        var getting = {
            subscribe: !!options.subscribe,
            // 'since-parents' = range of updates from parents to current
            // 'up-to-version' = bring client up to current (from scratch)
            // false = no history needed
            history:   (has_parents && v_eq(options.parents, version)) ? false
                : has_parents ? 'since-parents'
                : (options.subscribe || options.parents || options.transfer_encoding) ? 'up-to-version'
                : false,
            transfer_encoding: options.transfer_encoding,
        }
        getting.single_snapshot = !getting.subscribe && !getting.history

        // DT binary encoding: a transport optimization usable by any merge type.
        // Returns raw DT bytes instead of text.
        if (!getting.subscribe && getting.transfer_encoding === 'dt') {
            await ensure_dt_exists(resource)
            // If requesting the current version, skip the version lookup
            // (faster than asking DT about a version we already have)
            var req_version = options.version
            if (req_version && v_eq(req_version, version)) req_version = null

            var bytes = null
            if (req_version || options.parents) {
                if (req_version) {
                    var doc = dt_get(resource.dt.doc, req_version)
                    bytes = doc.toBytes()
                } else {
                    bytes = resource.dt.doc.toBytes()
                    var doc = Doc.fromBytes(bytes)
                }
                if (options.parents)
                    bytes = doc.getPatchSince(
                        dt_get_local_version(bytes, options.parents))
                doc.free()
            } else bytes = resource.dt.doc.toBytes()
            return { body: bytes }
        }

        // Single snapshot: return the text (optionally at a specific version)
        if (getting.single_snapshot) {
            if (has_version) {
                await ensure_dt_exists(resource)
                return options.full_response
                    ? { version: options.version, body: dt_get_string(resource.dt.doc, options.version) }
                    : dt_get_string(resource.dt.doc, options.version)
            }
            return options.full_response ? { version, body: resource.val } : resource.val
        }

        // Each merge-type has a different way of getting history
        switch (merge_type) {

        case 'yjs':
            await ensure_yjs_exists(resource)

            // Send history (for both one-shot and subscribe)
            if (getting.history) {
                if (getting.history === 'since-parents')
                    throw new Error('yjs-text from arbitrary parents not yet implemented')

                var yjs_updates = braid_text.from_yjs_binary(
                    Y.encodeStateAsUpdate(resource.yjs.doc))

                if (!getting.subscribe)
                    return yjs_updates

                for (var u of yjs_updates)
                    options.subscribe(u)
            }

            if (getting.subscribe) {
                // Register for live updates
                // NOTE: This stream mixes two version spaces:
                //   update.version: DT version space (frontier after this edit)
                //   update.patches[].version: Yjs version space (clientID-clock)
                var client = {
                    merge_type: 'yjs',
                    peer: options.peer,
                    send_update: one_at_a_time(options.subscribe),
                    abort() { resource.yjs.clients.delete(client) },
                }
                resource.yjs.clients.add(client)
                options.signal?.addEventListener('abort', () => client.abort())
            }
            break

        case 'simpleton':
            await ensure_dt_exists(resource)

            if (getting.history && !getting.subscribe)
                return dt_get_patches(resource.dt.doc,
                                      getting.history === 'since-parents' ? options.parents : undefined)

            if (getting.subscribe) {
                var client = {
                    merge_type: 'simpleton',
                    peer: options.peer,
                    send_update: one_at_a_time(options.subscribe),
                }

                // Send initial history
                if (getting.history === 'up-to-version')
                    client.send_update({ version, parents: [], body: resource.val })
                else if (getting.history === 'since-parents') {
                    var from = options.version || options.parents
                    var local_version = OpLog_remote_to_local(resource.dt.doc, from)
                    if (local_version)
                        client.send_update({
                            version, parents: from,
                            patches: get_xf_patches(resource.dt.doc, local_version)
                        })
                }

                client.abort = () => resource.simpleton.clients.delete(client)
                resource.simpleton.clients.add(client)
                options.signal?.addEventListener('abort', () => client.abort())
            }
            break

        case 'dt':
            await ensure_dt_exists(resource)

            if (getting.history && !getting.subscribe)
                return dt_get_patches(resource.dt.doc,
                                      getting.history === 'since-parents' ? options.parents : undefined)

            if (getting.subscribe) {
                var client = {
                    merge_type: 'dt',
                    peer: options.peer,
                    send_update: one_at_a_time(options.subscribe),
                    accept_encoding_dt: !!options.accept_encoding?.match(/updates\s*\((.*)\)/)?.[1]?.split(',').map(x=>x.trim()).includes('dt'),
                }

                // Send initial history
                if (client.accept_encoding_dt) {
                    if (!getting.history)
                        client.send_update({ encoding: 'dt', body: new Doc().toBytes() })
                    else {
                        var bytes = resource.dt.doc.toBytes()
                        if (getting.history === 'since-parents') {
                            var doc = Doc.fromBytes(bytes)
                            bytes = doc.getPatchSince(
                                dt_get_local_version(bytes, options.parents))
                            doc.free()
                        }
                        client.send_update({ encoding: 'dt', body: bytes })
                    }
                } else {
                    if (getting.history === 'up-to-version') {
                        client.send_update({ version: [], parents: [], body: "" })
                        var updates = dt_get_patches(resource.dt.doc)
                    } else if (getting.history === 'since-parents')
                        var updates = dt_get_patches(resource.dt.doc, options.parents || options.version)

                    if (updates) {
                        for (var u of updates)
                            client.send_update({
                                version: [u.version], parents: u.parents,
                                patches: [{ unit: u.unit, range: u.range, content: u.content }],
                            })

                    }
                }

                client.abort = () => resource.dt.clients.delete(client)
                resource.dt.clients.add(client)
                options.signal?.addEventListener('abort', () => client.abort())
            }
            break
        }
    }

    // Deprecated: Use client.abort() instead
    braid_text.forget = async (key, client) => {
        console.warn('braid_text.forget() is deprecated. Use client.abort() instead.')
        if (client && client.abort) client.abort()
    }

    braid_text.put = async (key, options) => {
        if (options.version) {
            validate_version_array(options.version)
            options.version.sort()
        }
        if (options.parents) {
            validate_version_array(options.parents)
            options.parents.sort()
        }

        if (key instanceof URL) {
            var params = {
                method: 'PUT',
                signal: options.signal,
            }
            if (!options.dont_retry)
                params.retry = () => true
            for (var x of ['headers', 'parents', 'version', 'peer', 'body', 'patches'])
                if (options[x] != null) params[x] = options[x]

            return { response: await braid_fetch(key.href, params) }
        }

        let resource = (typeof key == 'string') ? await get_resource(key) : key

        return await within_fiber('put:' + resource.key, async () => {

            // support for json patch puts..
            if (options.patches && options.patches.length &&
                options.patches.every(x => x.unit === 'json')) {
                let x = JSON.parse(resource.val)
                for (let p of options.patches)
                    apply_patch(x, p.range, p.content === '' ? undefined : JSON.parse(p.content))
                options = { body: JSON.stringify(x, null, 4) }
            }

            let { version, parents, patches, body, peer } = options

            // Yjs update: either raw binary (yjs_update) or yjs-text patches
            var yjs_binary = null
            var yjs_text_patches = null
            if (options.yjs_update) {
                yjs_binary = options.yjs_update instanceof Uint8Array
                    ? options.yjs_update : new Uint8Array(options.yjs_update)
            } else if (patches && patches.length && patches[0].unit === 'yjs-text') {
                yjs_text_patches = patches
                yjs_binary = braid_text.to_yjs_binary([{
                    version: options.version?.[0],
                    patches
                }])
            }

            if (yjs_binary) {
                await ensure_yjs_exists(resource)

                // Apply binary update to Y.Doc, capturing the delta
                var prev_text = resource.yjs.text.toString()
                var delta = null
                var observer = (e) => { delta = e.changes.delta }
                resource.yjs.text.observe(observer)
                try {
                    Y.applyUpdate(resource.yjs.doc, yjs_binary)
                } finally {
                    resource.yjs.text.unobserve(observer)
                }

                resource.val = resource.yjs.text.toString()

                // Sync to DT if it exists
                if (resource.dt && delta) {
                    var text_patches = yjs_delta_to_patches(delta, prev_text)
                    if (text_patches.length) {
                        var syn_actor = `yjs-${Date.now()}-${Math.random().toString(36).slice(2)}`
                        var syn_seq = 0
                        var version_before_yjs_sync = resource.version
                        var yjs_v_before = resource.dt.doc.getLocalVersion()
                        var dt_bytes = []
                        var dt_ps = resource.version
                        for (var tp of text_patches) {
                            var tp_range = tp.range.match(/-?\d+/g).map(Number)
                            var tp_del = tp_range[1] - tp_range[0]
                            var syn_v = `${syn_actor}-${syn_seq}`
                            if (tp_del) {
                                dt_bytes.push(dt_create_bytes(syn_v, dt_ps, tp_range[0], tp_del, null))
                                dt_ps = [`${syn_actor}-${syn_seq + tp_del - 1}`]
                                syn_seq += tp_del
                                syn_v = `${syn_actor}-${syn_seq}`
                            }
                            if (tp.content.length) {
                                dt_bytes.push(dt_create_bytes(syn_v, dt_ps, tp_range[0], 0, tp.content))
                                var cp_len = [...tp.content].length
                                dt_ps = [`${syn_actor}-${syn_seq + cp_len - 1}`]
                                syn_seq += cp_len
                            }
                        }
                        for (var b of dt_bytes) resource.dt.doc.mergeBytes(b)
                        resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()
                        if (!resource.dt.known_versions[syn_actor])
                            resource.dt.known_versions[syn_actor] = new RangeSet()
                        resource.dt.known_versions[syn_actor].add_range(0, syn_seq - 1)
                        await resource.dt.log.save(resource.dt.doc.getPatchSince(yjs_v_before))

                        // Broadcast to simpleton and DT clients
                        var xf = get_xf_patches(resource.dt.doc, yjs_v_before)
                        for (let client of resource.simpleton.clients) {
                            if (!peer || client.peer !== peer)
                                await client.send_update({
                                    version: resource.version,
                                    parents: version_before_yjs_sync,
                                    patches: xf
                                })
                        }
                        for (let client of resource.dt.clients) {
                            if (!peer || client.peer !== peer)
                                await client.send_update(
                                    client.accept_encoding_dt
                                        ? { version: resource.version,
                                            parents: version_before_yjs_sync,
                                            body: resource.dt.doc.getPatchSince(yjs_v_before),
                                            encoding: 'dt'
                                          }
                                    : { version: resource.version,
                                        parents: version_before_yjs_sync,
                                        patches: xf
                                      }
                                )
                        }
                    }
                }

                // Broadcast to yjs-text subscribers (skip sender)
                if (resource.yjs) {
                    // If we received yjs-text updates, reuse them; otherwise
                    // derive them from the binary update
                    var yjs_updates = yjs_text_patches
                        ? [{version: options.version, patches: yjs_text_patches}]
                        : braid_text.from_yjs_binary(yjs_binary)
                    for (var yjs_update of yjs_updates) {
                        for (var client of resource.yjs.clients) {
                            if (!peer || client.peer !== peer)
                                await client.send_update(yjs_update)
                        }
                    }
                }

                // Persist Yjs delta
                if (resource.yjs.log.save) await resource.yjs.log.save(yjs_binary)

                // Sanity check
                if (braid_text.debug_sync_checks && resource.dt) {
                    var dt_text = resource.dt.doc.get()
                    var yjs_text = resource.yjs.text.toString()
                    if (dt_text !== yjs_text) {
                        console.error(`SYNC MISMATCH key=${resource.key}: DT text !== Y.Doc text`)
                        console.error(`  DT:  ${dt_text.slice(0, 100)}... (${dt_text.length})`)
                        console.error(`  Yjs: ${yjs_text.slice(0, 100)}... (${yjs_text.length})`)
                    }
                }

                return { dt: { change_count: yjs_text_patches?.length || 1 } }
            }

            if (options.transfer_encoding === 'dt') {
                await ensure_dt_exists(resource)
                var start_i = 1 + resource.dt.doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)

                resource.dt.doc.mergeBytes(body)

                var end_i = resource.dt.doc.getLocalVersion().reduce((a, b) => Math.max(a, b), -1)
                for (var i = start_i; i <= end_i; i++) {
                    let v = resource.dt.doc.localToRemoteVersion([i])[0]
                    if (!resource.dt.known_versions[v[0]]) resource.dt.known_versions[v[0]] = new braid_text.RangeSet()
                    resource.dt.known_versions[v[0]].add_range(v[1], v[1])
                }
                resource.val = resource.dt.doc.get()
                resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()

                await resource.dt.log.save(body)

                // Notify non-simpleton clients with the dt-encoded update
                var dt_update = { body, encoding: 'dt' }
                for (let client of resource.dt.clients)
                    if (!peer || client.peer !== peer)
                        await client.send_update(dt_update)

                return { dt: { change_count: end_i - start_i + 1 } }
            }

            // Text/DT patches require DT
            await ensure_dt_exists(resource)

            if (version && !version.length) {
                console.log(`warning: ignoring put with empty version`)
                return { dt: { change_count: 0 } }
            }
            if (version && version.length > 1)
                throw new Error(`cannot put a version with multiple ids`)

            if (body != null && patches) throw new Error(`cannot have a body and patches`)
            if (body != null && (typeof body !== 'string')) throw new Error(`body must be a string`)
            if (patches) validate_patches(patches)

            if (parents) {
                // make sure we have all these parents
                for (let p of parents) {
                    let P = decode_version(p)
                    if (!resource.dt.known_versions[P[0]]?.has(P[1]))
                        throw new Error(`missing parent version: ${p}`)
                }
            }

            if (!parents) parents = resource.version

            let max_pos = resource.dt.length_at_version.get('' + parents) ??
                (v_eq(resource.version, parents) ? resource.dt.doc.len() : dt_len(resource.dt.doc, parents))

            if (body != null) {
                patches = [{
                    unit: 'text',
                    range: `[0:${max_pos}]`,
                    content: body
                }]
            }

            patches = patches.map((p) => ({
                ...p,
                range: p.range.match(/-?\d+/g).map((x) => {
                    let n = parseInt(x)
                    // Handle negative indices (including -0) as offsets from max_pos
                    if (Object.is(n, -0) || n < 0) return max_pos + n
                    return n
                }),
                content_codepoints: [...p.content],
            })).sort((a, b) => a.range[0] - b.range[0])

            let change_count = patches.reduce((a, b) => a + b.content_codepoints.length + (b.range[1] - b.range[0]), 0)

            // Nothing to do: e.g. PUT with empty body on an already-empty doc,
            // or patches that delete and insert zero characters.
            if (change_count === 0) return { dt: { change_count } }

            version = version?.[0] || `${(is_valid_actor(peer) && peer) || Math.random().toString(36).slice(2, 7)}-${change_count - 1}`

            let v = decode_version(version)
            var low_seq = v[1] + 1 - change_count
            if (low_seq < 0) throw new Error(`version seq ${v[1]} is too low for ${change_count} changes — use seq >= ${change_count - 1}`)

            // make sure we haven't seen this already
            var intersects_range = resource.dt.known_versions[v[0]]?.has(low_seq, v[1])
            if (intersects_range) {
                // if low_seq is below the range min,
                // then the intersection has gaps,
                // which is bad, meaning the prior versions must be different,
                // because what we're inserting is contiguous
                if (low_seq < intersects_range[0])
                    throw new Error('invalid update: different from previous update with same version')

                // see if we only have *some* of the versions
                var new_count = v[1] - intersects_range[1]
                if (new_count > 0) {
                    // divide the patches between old and new..
                    var new_patches = split_patches(patches, change_count - new_count)
                }

                if (options.validate_already_seen_versions)
                    validate_old_patches(resource, `${v[0]}-${low_seq}`, parents, patches)

                if (new_count <= 0) return { dt: { change_count } }

                change_count = new_count
                low_seq = v[1] + 1 - change_count
                parents = [`${v[0]}-${low_seq - 1}`]
                max_pos = resource.dt.length_at_version.get('' + parents) ??
                    (v_eq(resource.version, parents) ? resource.dt.doc.len() : dt_len(resource.dt.doc, parents))
                patches = new_patches
            }

            // validate patch positions
            let must_be_at_least = 0
            for (let p of patches) {
                if (p.range[0] < must_be_at_least || p.range[0] > max_pos)
                    throw new Error(`invalid patch range position: ${p.range[0]}`)
                if (p.range[1] < p.range[0] || p.range[1] > max_pos)
                    throw new Error(`invalid patch range position: ${p.range[1]}`)
                must_be_at_least = p.range[1]
            }

            resource.dt.length_at_version.put(`${v[0]}-${v[1]}`, patches.reduce((a, b) =>
                a + (b.content_codepoints?.length ?? 0) - (b.range[1] - b.range[0]),
                max_pos))

            if (!resource.dt.known_versions[v[0]]) resource.dt.known_versions[v[0]] = new RangeSet()
            resource.dt.known_versions[v[0]].add_range(low_seq, v[1])

            // get the version of the first character-wise edit
            v = `${v[0]}-${low_seq}`

            let ps = parents

            let version_before = resource.version
            let v_before = resource.dt.doc.getLocalVersion()

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

            for (let b of bytes) resource.dt.doc.mergeBytes(b)
            resource.val = resource.dt.doc.get()
            resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()

            // Get transformed patches (resolved after DT merge)
            // xf_patches: absolute positions (for simpleton clients)
            // xf_patches_relative: sequential positions (for Yjs sync)
            var xf_patches_relative = []
            for (let xf of resource.dt.doc.xfSince(v_before)) {
                xf_patches_relative.push(
                    xf.kind == "Ins"
                        ? { range: [xf.start, xf.start], content: xf.content }
                    : { range: [xf.start, xf.end], content: "" }
                )
            }
            var xf_patches = relative_to_absolute_patches(
                xf_patches_relative.map(p => ({
                    unit: 'text',
                    range: `[${p.range[0]}:${p.range[1]}]`,
                    content: p.content
                }))
            )

            // Sync to Yjs if it exists, using relative (sequential) patches
            if (resource.yjs) {
                var captured_yjs_update = null
                var yjs_update_handler = (update, origin) => {
                    if (origin === 'braid_text_dt_sync') captured_yjs_update = update
                }
                resource.yjs.doc.on('update', yjs_update_handler)
                resource.yjs.doc.transact(() => {
                    // xf_patches_relative are sequential codepoint positions; Yjs uses UTF-16
                    for (let p of xf_patches_relative) {
                        var current_text = resource.yjs.text.toString()
                        var cp_to_utf16 = codepoint_to_utf16_pos(current_text)
                        var utf16_start = cp_to_utf16(p.range[0])
                        var cp_del = p.range[1] - p.range[0]
                        if (cp_del) {
                            var utf16_end = cp_to_utf16(p.range[1])
                            resource.yjs.text.delete(utf16_start, utf16_end - utf16_start)
                        }
                        if (p.content?.length) resource.yjs.text.insert(utf16_start, p.content)
                    }
                }, 'braid_text_dt_sync')
                resource.yjs.doc.off('update', yjs_update_handler)

                // Broadcast to yjs-text subscribers
                // NOTE: There are two universes of version IDs here -- DT and Yjs --
                // and we are mixing them. The update-level .version is the DT frontier.
                // Each patch's .version is a Yjs item ID (clientID-clock).
                if (resource.yjs && captured_yjs_update) {
                    var yjs_updates = braid_text.from_yjs_binary(captured_yjs_update)
                    if (braid_text.verbose) console.log('DT→Yjs broadcast:', yjs_updates.length, 'updates to', resource.yjs.clients.size, 'yjs clients')
                    for (var yjs_update of yjs_updates)
                        for (var client of resource.yjs.clients)
                            if (!peer || client.peer !== peer)
                                await client.send_update(yjs_update)
                }

                // Persist Yjs delta
                if (captured_yjs_update) await resource.yjs.log.save(captured_yjs_update)

                // Sanity check
                if (braid_text.debug_sync_checks) {
                    var yjs_text = resource.yjs.text.toString()
                    if (resource.val !== yjs_text) {
                        console.error(`SYNC MISMATCH key=${resource.key}: DT→Yjs sync failed`)
                        console.error(`  val: ${resource.val.slice(0, 100)}... (${resource.val.length})`)
                        console.error(`  Yjs: ${yjs_text.slice(0, 100)}... (${yjs_text.length})`)
                    }
                }
            }

            // Transform stored cursor positions through the applied patches
            if (resource.cursors) resource.cursors.transform(patches)

            var post_commit_updates = []

            if (options.merge_type != "dt") {
                let patches = xf_patches
                if (braid_text.verbose) console.log(JSON.stringify({ patches }))

                for (let client of resource.simpleton.clients) {
                    if (peer && client.peer === peer) {
                        client.last_seen_version = [version]
                    }

                    function set_timeout(time_override) {
                        if (client.timeout) clearTimeout(client.timeout)
                        client.timeout = braid_text.simpletonSetTimeout(() => {
                            // if the doc has been freed, exit early
                            if (resource.dt.doc.__wbg_ptr === 0) return

                            let x = {
                                version: resource.version,
                                parents: client.last_seen_version
                            }
                            x.patches = get_xf_patches(resource.dt.doc, OpLog_remote_to_local(resource.dt.doc, client.last_seen_version))
                            client.send_update(x)

                            delete client.timeout
                        }, time_override ?? Math.min(3000, 23 * Math.pow(1.5, client.unused_version_count - 1)))
                    }

                    if (client.timeout) {
                        if (peer && client.peer === peer) {
                            set_timeout()
                        }
                        continue
                    }

                    let x = { version: resource.version }
                    if (peer && client.peer === peer) {
                        if (!v_eq(resource.version, [version])) {
                            client.unused_version_count = (client.unused_version_count ?? 0) + 1
                            set_timeout()
                            continue
                        } else {
                            delete client.unused_version_count
                        }

                        // this client already has this version, don't reflect back
                        continue
                    } else {
                        x.parents = version_before
                        x.patches = patches
                    }
                    post_commit_updates.push([client, x])
                }
            } else {
                if (resource.simpleton.clients.size) {
                    let x = {
                        version: resource.version,
                        parents: version_before,
                        patches: xf_patches
                    }
                    for (let client of resource.simpleton.clients) {
                        if (client.timeout) continue
                        post_commit_updates.push([client, x])
                    }
                }
            }

            var x = {
                version: [version],
                parents,
                patches: patches.map(p => ({
                    unit: p.unit,
                    range: `[${p.range.join(':')}]`,
                    content: p.content
                })),
            }
            for (let client of resource.dt.clients) {
                if (!peer || client.peer !== peer)
                    post_commit_updates.push([client, x])
            }

            await resource.dt.log.save(resource.dt.doc.getPatchSince(v_before))

            for (let [client, x] of post_commit_updates) await client.send_update(x)

            return { dt: { change_count } }
        })
    }

    braid_text.list = async () => {
        try {
            if (braid_text.db_folder) {
                await db_folder_init()
                var pages = new Set()
                for (let x of await require('fs').promises.readdir(braid_text.db_folder))
                    if (/\.(dt|yjs)\.\d+$/.test(x))
                        pages.add(decode_filename(x.replace(/\.(dt|yjs)\.\d+$/, '')))
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

    // ============================================================
    // Resource setup helpers
    // ============================================================

    // Load resource meta from disk (JSON file at meta/[key])
    async function setup_meta(resource) {
        if (!braid_text.db_folder) {
            resource.meta = {}
            resource.save_meta = () => {}
            return
        }
        await db_folder_init()
        var encoded = encode_filename(resource.key)
        var meta_path = `${braid_text.db_folder}/meta/${encoded}`
        try {
            resource.meta = JSON.parse(await fs.promises.readFile(meta_path))
        } catch (e) {
            resource.meta = {}
        }
        var dirty = false, saving = false
        resource.save_meta = async () => {
            dirty = true
            if (saving) return
            saving = true
            while (dirty) {
                dirty = false
                await atomic_write(meta_path, JSON.stringify(resource.meta),
                                   `${braid_text.db_folder}/temp`)
                await new Promise(done => setTimeout(done, braid_text.meta_file_save_period_ms))
            }
            saving = false
        }
    }

    // Create a fresh DT backend object
    function make_dt_backend() {
        return {
            doc: new Doc("server"),
            known_versions: {},
            length_at_version: create_simple_cache(braid_text.length_cache_size),
            clients: new Set(),
            log: { save: () => {} },
        }
    }

    // Create a fresh Yjs backend object
    function make_yjs_backend(channel) {
        require_yjs()
        var doc = new Y.Doc()
        return {
            doc,
            text: doc.getText(channel),
            channel,
            clients: new Set(),
            log: { save: () => {} },
        }
    }

    // Rebuild DT version indexes from doc bytes
    function rebuild_dt_indexes(resource) {
        resource.dt.known_versions = {}
        dt_get_actor_seq_runs([...resource.dt.doc.toBytes()], (actor, base, len) => {
            if (!resource.dt.known_versions[actor])
                resource.dt.known_versions[actor] = new RangeSet()
            resource.dt.known_versions[actor].add_range(base, base + len - 1)
        })
    }

    // Set up a write-ahead-plus-compated-state log for a backend (DT or Yjs).
    // Loads existing data from disk via on_chunk callback.
    // Provides resource[type].log.save(bytes) for future writes.
    //
    // File format: [key].[type].[N]
    //   Each file: [4-byte len][chunk] [4-byte len][chunk] ...
    //   First chunk sets compaction threshold (10x its size)
    //   When file exceeds threshold, get_compacted() is called to write a fresh file
    async function setup_compacting_log(resource, type, on_chunk, get_compacted) {
        if (!braid_text.db_folder) {
            resource[type].log = { save: () => {} }
            return
        }
        await db_folder_init()
        var encoded = encode_filename(resource.key)

        var log = {
            file_number: 0,
            file_size: 0,
            threshold: 0,
            save: () => {},  // placeholder until fully initialized below
        }
        resource[type].log = log

        // Load existing files
        var files = (await get_files_for_key(resource.key, type))
            .filter(x => x.match(/\.\d+$/))
            .sort((a, b) => parseInt(a.match(/\d+$/)[0]) - parseInt(b.match(/\d+$/)[0]))

        var loaded = false
        for (var i = files.length - 1; i >= 0; i--) {
            if (loaded) {
                await fs.promises.unlink(files[i])
                continue
            }
            try {
                var data = await fs.promises.readFile(files[i])
                var cursor = 0, first = true
                while (cursor < data.length) {
                    var chunk_size = data.readUInt32LE(cursor)
                    cursor += 4
                    on_chunk(data.slice(cursor, cursor + chunk_size))
                    cursor += chunk_size
                    if (first) { log.threshold = chunk_size * 10; first = false }
                }
                log.file_size = data.length
                log.file_number = parseInt(files[i].match(/(\d+)$/)[1])
                loaded = true
            } catch (error) {
                console.error(`Error loading ${files[i]}: ${error.message}`)
                await fs.promises.unlink(files[i])
            }
        }

        // Save function: append delta or compact with snapshot
        log.save = (bytes) => within_fiber('log:' + resource.key + ':' + type, async () => {
            log.file_size += bytes.length + 4
            var filename = `${braid_text.db_folder}/${encoded}.${type}.${log.file_number}`

            if (log.file_size < log.threshold) {
                // Append with WAL-intent for crash safety
                var len_buf = Buffer.allocUnsafe(4)
                len_buf.writeUInt32LE(bytes.length, 0)
                var append_data = Buffer.concat([len_buf, bytes])

                var basename = require('path').basename(filename)
                var intent_path = `${braid_text.db_folder}/wal-intent/${basename}`
                var stat = await fs.promises.stat(filename)
                var size_buf = Buffer.allocUnsafe(8)
                size_buf.writeBigUInt64LE(BigInt(stat.size), 0)

                await atomic_write(intent_path, Buffer.concat([size_buf, append_data]),
                                   `${braid_text.db_folder}/temp`)
                await fs.promises.appendFile(filename, append_data)
                await fs.promises.unlink(intent_path)
            } else {
                // Compact: write full compaction to new file, delete old
                log.file_number++
                var snap = get_compacted()
                var buffer = Buffer.allocUnsafe(4)
                buffer.writeUInt32LE(snap.length, 0)

                var new_filename = `${braid_text.db_folder}/${encoded}.${type}.${log.file_number}`
                await atomic_write(new_filename, Buffer.concat([buffer, snap]),
                                   `${braid_text.db_folder}/temp`)

                log.file_size = 4 + snap.length
                log.threshold = log.file_size * 10
                try { await fs.promises.unlink(filename) } catch (e) {}
            }
        })
    }

    // ============================================================
    // get_resource
    // ============================================================

    async function get_resource(key, options) {
        var cache = braid_text.cache
        if (!cache[key]) cache[key] = new Promise(async done => {
            var resource = {
                key,
                dt: null,
                yjs: null,
                simpleton: { clients: new Set() },
                val: '',
                version: [],
                cursors: null,
                // Returns all subscriber clients across all merge types
                clients() {
                    var all = [...this.simpleton.clients]
                    if (this.dt) all.push(...this.dt.clients)
                    if (this.yjs) all.push(...this.yjs.clients)
                    return all
                },
            }

            // Always load meta first
            await setup_meta(resource)

            // Check what's on disk
            var has_dt = braid_text.db_folder
                && (await get_files_for_key(key, 'dt')).length > 0
            var has_yjs = braid_text.db_folder && Y
                && (await get_files_for_key(key, 'yjs')).length > 0

            // Get initializer spec if nothing on disk
            var init = (has_dt || has_yjs) ? null : (
                options?.initializer ? await options.initializer() : null
            )

            // --- Load from disk ---
            if (has_dt) {
                resource.dt = make_dt_backend()
                await setup_compacting_log(resource, 'dt',
                                           (bytes) => resource.dt.doc.mergeBytes(bytes),
                                           () => resource.dt.doc.toBytes())
                rebuild_dt_indexes(resource)
                resource.val = resource.dt.doc.get()
                resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()
            }
            if (has_yjs) {
                var channel = resource.meta.yjs_channel || 'text'
                resource.yjs = make_yjs_backend(channel)
                await setup_compacting_log(resource, 'yjs',
                                           (bytes) => Y.applyUpdate(resource.yjs.doc, bytes),
                                           () => Y.encodeStateAsUpdate(resource.yjs.doc))
                var yjs_text = resource.yjs.text.toString()
                if (resource.dt) {
                    if (resource.val !== yjs_text) {
                        console.error(`INIT MISMATCH key=${key}: DT="${resource.val.slice(0,50)}" Yjs="${yjs_text.slice(0,50)}"`)
                    }
                } else {
                    resource.val = yjs_text
                }
            }

            // --- Initialize from external source (only when nothing on disk) ---
            if (init) {
                if (init.yjs) {
                    var channel = (typeof init.yjs === 'object' && init.yjs.channel) || 'text'
                    var history = typeof init.yjs === 'object' && init.yjs.history
                    resource.yjs = make_yjs_backend(channel)
                    resource.meta.yjs_channel = channel
                    resource.save_meta()
                    if (history) {
                        Y.applyUpdate(resource.yjs.doc,
                                      history instanceof Uint8Array ? history : new Uint8Array(history))
                        resource.val = resource.yjs.text.toString()
                    }
                    await setup_compacting_log(resource, 'yjs',
                                               (bytes) => Y.applyUpdate(resource.yjs.doc, bytes),
                                               () => Y.encodeStateAsUpdate(resource.yjs.doc))
                    await resource.yjs.log.save(Y.encodeStateAsUpdate(resource.yjs.doc))
                }
                if (init.dt) {
                    var dt_history = typeof init.dt === 'object' && init.dt.history
                    resource.dt = make_dt_backend()
                    if (dt_history) {
                        resource.dt.doc.mergeBytes(
                            dt_history instanceof Uint8Array ? dt_history : new Uint8Array(dt_history))
                    } else if (resource.val) {
                        resource.dt.doc.mergeBytes(
                            dt_create_bytes('999999999-0', [], 0, 0, resource.val))
                    }
                    rebuild_dt_indexes(resource)
                    resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()
                    if (!resource.val) resource.val = resource.dt.doc.get()
                    await setup_compacting_log(resource, 'dt',
                                               (bytes) => resource.dt.doc.mergeBytes(bytes),
                                               () => resource.dt.doc.toBytes())
                    await resource.dt.log.save(resource.dt.doc.toBytes())
                }
            }

            // Sanity check
            if (resource.dt && resource.yjs) {
                var dt_text = resource.dt.doc.get()
                var yjs_text = resource.yjs.text.toString()
                if (dt_text !== yjs_text)
                    console.error(`get_resource key=${key}: DT and Yjs disagree: DT="${dt_text.slice(0,50)}" Yjs="${yjs_text.slice(0,50)}"`)
            }

            // Delete method
            resource.delete = async () => {
                if (resource.dt) resource.dt.doc.free()
                if (resource.yjs) resource.yjs.doc.destroy()
                delete braid_text.cache[key]
                if (braid_text.db_folder) {
                    for (var file of await get_files_for_key(key))
                        try { await fs.promises.unlink(file) } catch (e) {}
                    try {
                        await fs.promises.unlink(`${braid_text.db_folder}/meta/${encode_filename(key)}`)
                    } catch (e) {}
                }
                if (key_to_filename.has(key)) {
                    ifilenames.delete(key_to_filename.get(key).toLowerCase())
                    key_to_filename.delete(key)
                }
            }

            done(resource)
        })
        return await cache[key]
    }

    // Internal: create DT backend on demand, synced from resource.val
    async function ensure_dt_exists(resource) {
        if (resource.dt) return
        resource.dt = make_dt_backend()
        if (resource.val) {
            resource.dt.doc.mergeBytes(
                dt_create_bytes('999999999-0', [], 0, 0, resource.val))
        }
        rebuild_dt_indexes(resource)
        resource.version = resource.dt.doc.getRemoteVersion().map(x => x.join("-")).sort()
        await setup_compacting_log(resource, 'dt',
                                   (bytes) => resource.dt.doc.mergeBytes(bytes),
                                   () => resource.dt.doc.toBytes())
    }

    // Internal: create Yjs backend on demand, synced from resource.val
    async function ensure_yjs_exists(resource, options) {
        if (resource.yjs) return
        var channel = options?.channel || resource.meta?.yjs_channel || 'text'
        resource.yjs = make_yjs_backend(channel)
        if (resource.val) {
            resource.yjs.text.insert(0, resource.val)
        }
        resource.meta.yjs_channel = channel
        resource.save_meta()
        await setup_compacting_log(resource, 'yjs',
                                   (bytes) => Y.applyUpdate(resource.yjs.doc, bytes),
                                   () => Y.encodeStateAsUpdate(resource.yjs.doc))
    }

    async function db_folder_init() {
        if (braid_text.verbose) console.log('__!')
        if (!db_folder_init.p) db_folder_init.p = (async () => {
            await fs.promises.mkdir(braid_text.db_folder, { recursive: true });

            // Migrate from old dot-prefixed directory names to new names
            // This is idempotent: safe to re-run if interrupted mid-migration
            async function migrate_dir(old_name, new_name) {
                var old_path = `${braid_text.db_folder}/${old_name}`
                var new_path = `${braid_text.db_folder}/${new_name}`
                try {
                    await fs.promises.stat(old_path)
                    // Old dir exists — ensure new dir exists and move contents
                    await fs.promises.mkdir(new_path, { recursive: true })
                    var entries = await fs.promises.readdir(old_path)
                    for (var entry of entries) {
                        var src = `${old_path}/${entry}`
                        var dst = `${new_path}/${entry}`
                        try { await fs.promises.stat(dst) } catch (e) {
                            // dst doesn't exist, move src there
                            await fs.promises.rename(src, dst)
                        }
                        // If dst already exists (crash recovery), just remove src
                        try { await fs.promises.unlink(src) } catch (e) {}
                    }
                    // Remove old dir once empty
                    try { await fs.promises.rmdir(old_path) } catch (e) {}
                } catch (e) {
                    // Old dir doesn't exist — no migration needed
                }
            }
            await migrate_dir('.meta', 'meta')
            await migrate_dir('.temp', 'temp')
            await migrate_dir('.wal-intent', 'wal-intent')

            // Migrate data files from [key].N to [key].dt.N
            // Idempotent: only renames files that match old pattern but not new
            var all_files = await fs.promises.readdir(braid_text.db_folder)
            for (var f of all_files) {
                // Match old format: ends with .N (digits only) but not .dt.N or .yjs.N
                if (/\.\d+$/.test(f) && !/\.(dt|yjs)\.\d+$/.test(f)) {
                    var new_name = f.replace(/\.(\d+)$/, '.dt.$1')
                    var old_path = `${braid_text.db_folder}/${f}`
                    var new_path = `${braid_text.db_folder}/${new_name}`
                    try { await fs.promises.stat(new_path) } catch (e) {
                        // New file doesn't exist, rename
                        await fs.promises.rename(old_path, new_path)
                        continue
                    }
                    // If new file already exists (crash recovery), remove old
                    try { await fs.promises.unlink(old_path) } catch (e) {}
                }
            }

            await fs.promises.mkdir(`${braid_text.db_folder}/meta`, { recursive: true })
            await fs.promises.mkdir(`${braid_text.db_folder}/temp`, { recursive: true })
            await fs.promises.mkdir(`${braid_text.db_folder}/wal-intent`, { recursive: true })

            // Clean out temp directory on startup
            var temp_files = await fs.promises.readdir(`${braid_text.db_folder}/temp`)
            for (var f of temp_files)
                await fs.promises.unlink(`${braid_text.db_folder}/temp/${f}`)

            // Replay any pending wal-intent files
            var intent_files = await fs.promises.readdir(`${braid_text.db_folder}/wal-intent`)
            for (var intent_name of intent_files) {
                var intent_path = `${braid_text.db_folder}/wal-intent/${intent_name}`
                var target_path = `${braid_text.db_folder}/${intent_name}`

                var intent_data = await fs.promises.readFile(intent_path)
                var expected_size = Number(intent_data.readBigUInt64LE(0))
                var append_data = intent_data.subarray(8)

                var stat = await fs.promises.stat(target_path)
                if (stat.size < expected_size || stat.size > expected_size + append_data.length)
                    throw new Error(`wal-intent replay failed: ${target_path} size ${stat.size}, expected ${expected_size} to ${expected_size + append_data.length}`)

                // Append whatever portion hasn't been written yet
                var already_written = stat.size - expected_size
                if (already_written < append_data.length)
                    await fs.promises.appendFile(target_path, append_data.subarray(already_written))
                await fs.promises.unlink(intent_path)
            }

            // Populate key_to_filename mapping from existing files
            var files = (await fs.promises.readdir(braid_text.db_folder))
                .filter(x => /\.dt\.\d+$/.test(x))
            init_filename_mapping(files)
        })()
        await db_folder_init.p
    }

    async function get_files_for_key(key, type) {
        await db_folder_init()
        try {
            var suffix = type ? `\\.${type}\\.\\d+$` : `\\.(dt|yjs)\\.\\d+$`
            let re = new RegExp("^" + encode_filename(key).replace(/[^a-zA-Z0-9]/g, "\\$&") + suffix)
            return (await fs.promises.readdir(braid_text.db_folder))
                .filter((a) => re.test(a))
                .map((a) => `${braid_text.db_folder}/${a}`)
        } catch (e) { return [] }    
    }

    // (file_sync removed — replaced by setup_meta and setup_compacting_log above)

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

    function validate_old_patches(resource, base_v, parents, patches) {
        // if we have seen it already, make sure it's the same as before
        let updates = dt_get_patches(resource.dt.doc, parents)

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

        let v = base_v
        let ps = parents
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
        if (version && v_eq(version,
                            doc.getRemoteVersion().map((x) => x.join("-")).sort())) {
            // they want everything past the end, which is nothing
            return []
        }

        let bytes = doc.toBytes()
        doc = Doc.fromBytes(bytes)

        let [_agents, versions, parentss] = dt_parse([...bytes])

        let op_runs = []
        if (version?.length) {
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

    function dt_get_actor_seq_runs(byte_array, cb) {
        if (new TextDecoder().decode(new Uint8Array(byte_array.splice(0, 8))) !== "DMNDTYPS") throw new Error("dt parse error, expected DMNDTYPS")

        if (byte_array.shift() != 0) throw new Error("dt parse error, expected version 0")

        let agents = []

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

                    cb(agents[agent_i], base, run_length)
                    seqs[agent_i] = base + run_length
                }
            } else {
                byte_array.splice(0, len)
            }
        }
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
            if (!a?.length) return []
            var l = 0, r = a.length
            while (l < r) {
                var m = Math.floor((l + r) / 2)
                if (a[m] < s) l = m + 1; else r = m
            }
            var i = l
            l = i; r = a.length
            while (l < r) {
                m = Math.floor((l + r) / 2)
                if (a[m] <= e) l = m + 1; else r = m
            }
            return a.splice(i, l - i)
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
        var result = relative_to_absolute_patches(patches)
        return result
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
                    node.content = node.content.slice(0, codepoints_to_index(node.content, start)) + p.content + node.content.slice(codepoints_to_index(node.content, start + del))
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
                        next.content = p.content + next.content.slice(codepoints_to_index(next.content, remaining))
                        resize(node, start)
                        if (node.size == 0) avl.del(node)
                        resize(next, count_code_points(next.content))
                    }
                } else {
                    if (next.content == null) {
                        node.del += middle_del + remaining
                        node.content = node.content.slice(0, codepoints_to_index(node.content, start)) + p.content
                        resize(node, count_code_points(node.content))
                        resize(next, next.size - remaining)
                    } else {
                        node.del += middle_del + next.del
                        node.content = node.content.slice(0, codepoints_to_index(node.content, start)) + p.content + next.content.slice(codepoints_to_index(next.content, remaining))
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

    function index_to_codepoints(str, index) {
        var i = 0, c = 0
        while (i < index && i < str.length) {
            var code = str.charCodeAt(i)
            i += (code >= 0xd800 && code <= 0xdbff) ? 2 : 1
            c++
        }
        return c
    }

    function codepoints_to_index(str, codepoints) {
        var i = 0, c = 0
        while (c < codepoints && i < str.length) {
            var code = str.charCodeAt(i)
            i += (code >= 0xd800 && code <= 0xdbff) ? 2 : 1
            c++
        }
        return i
    }

    // Mapping between keys and their encoded filenames
    // Populated at init time, used to avoid re-encoding and handle case collisions
    var key_to_filename = new Map()
    var ifilenames = new Set()

    function encode_filename(key) {
        // Return cached encoding if we've seen this key before
        if (key_to_filename.has(key)) {
            return key_to_filename.get(key)
        }

        // Swap all "!" and "/" characters so paths are more readable on disk
        var swapped = key.replace(/[!/]/g, (match) => (match === "!" ? "/" : "!"))

        // Encode unsafe filesystem characters
        var encoded = encode_file_path_component(swapped)

        // Resolve case collisions for case-insensitive filesystems (Mac/Windows)
        encoded = encode_to_avoid_icase_collision(encoded, ifilenames)

        // Cache the mapping
        key_to_filename.set(key, encoded)
        ifilenames.add(encoded.toLowerCase())

        return encoded
    }

    function decode_filename(encodedFilename) {
        // Decode the filename
        var decoded = decodeURIComponent(encodedFilename)

        // Swap all "/" and "!" characters back
        decoded = decoded.replace(/[!/]/g, (match) => (match === "/" ? "!" : "/"))

        return decoded
    }

    // Populate key_to_filename mapping from existing files on disk
    function init_filename_mapping(files) {
        for (var file of files) {
            // Extract the encoded key (strip extension like .dt.0, .dt.1, etc.)
            var encoded = file.replace(/\.(dt|yjs)\.\d+$/, '')
            var key = decode_filename(encoded)

            if (!key_to_filename.has(key)) {
                key_to_filename.set(key, encoded)
                ifilenames.add(encoded.toLowerCase())
            } else {
                // Already have this key mapped - verify it maps to the same encoding
                if (key_to_filename.get(key) !== encoded) {
                    throw new Error(`filename conflict detected: key "${key}" maps to both "${key_to_filename.get(key)}" and "${encoded}"`)
                }
                // Otherwise it's just a re-initialization, skip it
            }
        }
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
        if (x.unit === 'yjs-text') return validate_yjs_patch(x)
        if (x.unit && x.unit !== 'text') throw new Error(`invalid patch unit '${x.unit}': only 'text' and 'yjs-text' supported`)
        if (typeof x.range !== 'string') throw new Error(`invalid patch range: must be a string`)
        if (!x.range.match(/^\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]\s*$/)) throw new Error(`invalid patch range: ${x.range}`)
        if (typeof x.content !== 'string') throw new Error(`invalid patch content: must be a string`)
    }

    // yjs-text range format:
    //   Inserts (exclusive):  yjs-text (clientID-clock:clientID-clock)
    //   Deletes (inclusive):  yjs-text [clientID-clock:clientID-clock]
    //   Null origins:         (:), (:42-5), (42-5:)
    //   Client IDs and clocks are always non-negative integers.

    var yjs_id_pattern = '(\\d+-\\d+)'
    var yjs_range_re = new RegExp(
        '^\\s*' +
            '([\\(\\[])' +                        // open bracket: ( or [
            '\\s*' + yjs_id_pattern + '?' +        // optional left ID
            '\\s*:\\s*' +                          // colon separator
            yjs_id_pattern + '?' + '\\s*' +        // optional right ID
            '([\\)\\]])' +                         // close bracket: ) or ]
            '\\s*$'
    )

    function validate_yjs_patch(x) {
        if (typeof x != 'object') throw new Error(`invalid yjs patch: not an object`)
        if (typeof x.range !== 'string') throw new Error(`invalid yjs patch range: must be a string`)
        if (typeof x.content !== 'string') throw new Error(`invalid yjs patch content: must be a string`)
        var parsed = parse_yjs_range(x.range)
        if (!parsed) throw new Error(`invalid yjs patch range: ${x.range}`)
    }

    function parse_yjs_range(range_string) {
        var m = range_string.match(yjs_range_re)
        if (!m) return null

        var open = m[1]     // ( or [
        var left = m[2]     // e.g. "42-5" or undefined
        var right = m[3]    // e.g. "73-2" or undefined
        var close = m[4]    // ) or ]

        // Validate bracket pairing: () for exclusive, [] for inclusive
        var exclusive = (open === '(' && close === ')')
        var inclusive = (open === '[' && close === ']')
        if (!exclusive && !inclusive) return null

        function parse_id(s) {
            if (!s) return null
            var dash = s.lastIndexOf('-')
            return { client: parseInt(s.slice(0, dash)), clock: parseInt(s.slice(dash + 1)) }
        }

        var result = {
            inclusive: inclusive,
            left: parse_id(left),
            right: parse_id(right)
        }

        // Inclusive ranges must have at least one ID (can't delete nothing)
        if (inclusive && !result.left && !result.right) return null

        return result
    }

    // Convert a Yjs delta (array of {retain, insert, delete} ops)
    // to positional text patches [{unit, range, content}]
    // range is returned as a parsed array [start, end], not a string
    // Convert a Yjs delta to positional text patches with codepoint positions.
    // Yjs deltas use UTF-16 positions; we need to convert to codepoints for DT.
    // prev_text is the text BEFORE the delta was applied (in UTF-16, i.e. a JS string).
    function yjs_delta_to_patches(delta, prev_text) {
        var patches = []
        var utf16_pos = 0
        var cp_pos = 0
        for (var op of delta) {
            if (op.retain) {
                // Count codepoints in the retained region
                var retained = prev_text.slice(utf16_pos, utf16_pos + op.retain)
                cp_pos += [...retained].length
                utf16_pos += op.retain
            } else if (op.insert) {
                var cp_len = [...op.insert].length
                patches.push({
                    unit: 'text',
                    range: `[${cp_pos}:${cp_pos}]`,
                    content: op.insert
                })
                cp_pos += cp_len
            } else if (op.delete) {
                var deleted = prev_text.slice(utf16_pos, utf16_pos + op.delete)
                var cp_del = [...deleted].length
                patches.push({
                    unit: 'text',
                    range: `[${cp_pos}:${cp_pos + cp_del}]`,
                    content: ''
                })
                utf16_pos += op.delete
            }
        }
        return patches
    }

    // Convert codepoint index to UTF-16 index in a string.
    // Returns a function that maps codepoint position -> UTF-16 position.
    function codepoint_to_utf16_pos(str) {
        return function(cp_pos) {
            var utf16 = 0
            var cp = 0
            while (cp < cp_pos && utf16 < str.length) {
                var code = str.charCodeAt(utf16)
                utf16 += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1
                cp++
            }
            return utf16
        }
    }

    braid_text.parse_yjs_range = parse_yjs_range
    braid_text.validate_patches = validate_patches

    // Convert a Yjs binary update to yjs-text range patches.
    // Decodes the binary without needing a Y.Doc.
    // Returns array of {unit: 'yjs-text', range: '...', content: '...'}
    // Convert a Yjs binary update to an array of braid updates,
    // each with a version and patches in yjs-text format.
    braid_text.from_yjs_binary = function(update) {
        require_yjs()
        var decoded = Y.decodeUpdate(
            update instanceof Uint8Array ? update : new Uint8Array(update))
        var updates = []

        // Each inserted struct becomes one update with one insert patch.
        // GC'd structs (deleted items) have content.len but no content.str —
        // we emit placeholder text since the delete set will remove it anyway.
        for (var struct of decoded.structs) {
            var text = struct.content?.str
            if (!text && struct.content?.len) text = '_'.repeat(struct.content.len)
            if (!text) continue  // skip non-text items (e.g. format, embed)
            var id = struct.id
            var origin = struct.origin
            var rightOrigin = struct.rightOrigin
            var left = origin ? `${origin.client}-${origin.clock}` : ''
            var right = rightOrigin ? `${rightOrigin.client}-${rightOrigin.clock}` : ''
            updates.push({
                version: [`${id.client}-${id.clock}`],
                patches: [{
                    unit: 'yjs-text',
                    range: `(${left}:${right})`,
                    content: text,
                }]
            })
        }

        // Each delete range becomes one update with one delete patch
        for (var [clientID, deleteItems] of decoded.ds.clients) {
            for (var item of deleteItems) {
                var left = `${clientID}-${item.clock}`
                var right = `${clientID}-${item.clock + item.len - 1}`
                updates.push({
                    version: [`${clientID}-${item.clock}`],
                    patches: [{
                        unit: 'yjs-text',
                        range: `[${left}:${right}]`,
                        content: ''
                    }]
                })
            }
        }

        return updates
    }

    // Convert yjs-text range patches to a Yjs binary update.
    // Convert braid updates with yjs-text patches to a Yjs binary update.
    // This is the inverse of from_yjs_binary.
    // Accepts an array of updates, each with {version, patches}.
    braid_text.to_yjs_binary = function(updates) {
        require_yjs()
        var lib0_encoding = require('lib0/encoding')
        var encoder = new Y.UpdateEncoderV1()

        // Group inserts by client
        var inserts_by_client = new Map()
        var deletes_by_client = new Map()

        for (var update of updates) {
            if (!update.patches) continue
            for (var p of update.patches) {
                var parsed = parse_yjs_range(p.range)
                if (!parsed) throw new Error(`invalid yjs-text range: ${p.range}`)

                if (p.content.length > 0) {
                    // Insert — version on the update is the item ID as ["client-clock"]
                    var v_str = Array.isArray(update.version) ? update.version[0] : update.version
                    if (!v_str) throw new Error('insert update requires .version = ["client-clock"]')
                    var v_parts = v_str.match(/^(\d+)-(\d+)$/)
                    if (!v_parts) throw new Error('invalid update version: ' + v_str)
                    var item_id = { client: parseInt(v_parts[1]), clock: parseInt(v_parts[2]) }
                    var list = inserts_by_client.get(item_id.client) || []
                    list.push({ id: item_id, origin: parsed.left, rightOrigin: parsed.right, content: p.content })
                    inserts_by_client.set(item_id.client, list)
                } else {
                    // Delete
                    if (!parsed.left) throw new Error('delete patch requires left ID')
                    var client = parsed.left.client
                    var list = deletes_by_client.get(client) || []
                    list.push({ clock: parsed.left.clock, len: parsed.right ? parsed.right.clock - parsed.left.clock + 1 : 1 })
                    deletes_by_client.set(client, list)
                }
            }
        }

        // Write structs
        lib0_encoding.writeVarUint(encoder.restEncoder, inserts_by_client.size)
        for (var [client, items] of inserts_by_client) {
            items.sort((a, b) => a.id.clock - b.id.clock)
            lib0_encoding.writeVarUint(encoder.restEncoder, items.length)
            encoder.writeClient(client)
            lib0_encoding.writeVarUint(encoder.restEncoder, items[0].id.clock)
            for (var item of items) {
                var has_origin = item.origin !== null
                var has_right_origin = item.rightOrigin !== null
                // info byte: content ref (4 = string) | origin flags
                var info = 4 | (has_origin ? 0x80 : 0) | (has_right_origin ? 0x40 : 0)
                encoder.writeInfo(info)
                if (has_origin) encoder.writeLeftID(Y.createID(item.origin.client, item.origin.clock))
                if (has_right_origin) encoder.writeRightID(Y.createID(item.rightOrigin.client, item.rightOrigin.clock))
                if (!has_origin && !has_right_origin) {
                    // Root insert — write parent type key
                    encoder.writeParentInfo(true)
                    encoder.writeString('text')
                }
                encoder.writeString(item.content)
            }
        }

        // Write delete set
        lib0_encoding.writeVarUint(encoder.restEncoder, deletes_by_client.size)
        for (var [client, deletes] of deletes_by_client) {
            lib0_encoding.writeVarUint(encoder.restEncoder, client)
            lib0_encoding.writeVarUint(encoder.restEncoder, deletes.length)
            for (var d of deletes) {
                encoder.writeDsClock(d.clock)
                encoder.writeDsLen(d.len)
            }
        }

        return encoder.toUint8Array()
    }

    // Splits an array of patches at a given character position within the
    // combined delete+insert sequence.
    //
    // Patches are objects with:
    //   - unit: string (e.g., 'text')
    //   - range: [start, end] - character positions for deletion
    //   - content: string - the content to insert
    //   - content_codepoints: array of single characters
    //
    // Each patch represents a "replace" operation: delete then insert.
    // The combined sequence for patches is:
    //   del(patch1), ins(patch1), del(patch2), ins(patch2), ...
    //
    // The split_point is an index into this combined sequence.
    //
    // Example: patches with del(3),ins(4),del(2),ins(5)
    //   - split_point 1 falls in first del(3)
    //   - split_point 5 falls in first ins(4) (positions 3-6)
    //   - split_point 7 falls in second del(2) (positions 7-8)
    //
    // First patches: operations up to split_point
    // Second patches: operations from split_point onward (ranges adjusted)
    function split_patches(patches, split_point) {
        let second_patches = []

        let position = 0  // current position in the combined sequence
        let adjustment = 0  // how much to adjust second patches' ranges
        let first_len = 0  // how many patches stay in first (modified in place)

        for (let i = 0; i < patches.length; i++) {
            let p = patches[i]
            let delete_length = p.range[1] - p.range[0]
            let insert_length = p.content_codepoints.length

            let del_start = position
            let del_end = position + delete_length
            let ins_start = del_end
            let ins_end = ins_start + insert_length

            if (split_point >= ins_end) {
                // Entire patch is before split point - stays in first (unchanged)
                first_len++
                // Adjustment: this patch removes delete_length and adds insert_length
                adjustment += insert_length - delete_length
            } else if (split_point <= del_start) {
                // Entire patch is after split point - goes to second (adjusted)
                second_patches.push({
                    unit: p.unit,
                    range: [p.range[0] + adjustment, p.range[1] + adjustment],
                    content: p.content,
                    content_codepoints: p.content_codepoints
                })
            } else if (split_point <= del_end) {
                // Split point is within the delete portion
                let del_chars_before = split_point - del_start

                // Save original values before modifying
                let original_range_end = p.range[1]
                let original_content = p.content
                let original_content_codepoints = p.content_codepoints

                // First patches: partial delete, no insert (modify in place)
                p.range[1] = p.range[0] + del_chars_before
                p.content = ''
                p.content_codepoints = []
                first_len++

                // Adjustment from partial delete
                adjustment -= del_chars_before

                // Second patches: remaining delete + full insert (adjusted)
                second_patches.push({
                    unit: p.unit,
                    range: [p.range[1] + adjustment, original_range_end + adjustment],
                    content: original_content,
                    content_codepoints: original_content_codepoints
                })
            } else {
                // Split point is within the insert portion (split_point > del_end && split_point < ins_end)
                let ins_chars_before = split_point - ins_start
                let original_content_codepoints = p.content_codepoints

                // First patches: full delete + partial insert (modify in place)
                p.content_codepoints = p.content_codepoints.slice(0, ins_chars_before)
                p.content = p.content_codepoints.join('')
                first_len++

                // After first patches applied, the position for remaining insert is:
                // p.range[0] (original position)
                // + adjustment (net change from all prior first_patches)
                // + ins_chars_before (what this patch's first part inserted)
                let adjusted_pos = p.range[0] + adjustment + ins_chars_before

                let content_codepoints = original_content_codepoints.slice(ins_chars_before)
                second_patches.push({
                    unit: p.unit,
                    range: [adjusted_pos, adjusted_pos],
                    content: content_codepoints.join(''),
                    content_codepoints
                })

                // Update adjustment: full delete removed, partial insert added
                adjustment += ins_chars_before - delete_length
            }

            position = ins_end
        }

        // Truncate patches array to only contain first_patches
        patches.length = first_len

        return second_patches
    }

    // Create a LRU cache.  It evicts stuff when it gets greater than `size` in LRU order.
    function create_simple_cache(size) {
        // This map will iterate over keys in the order they were inserted.
        // Eviction will remove from the front of the map.
        // So we want every delete() and set() operation to move a key/value to the end.
        var map = new Map()
        return {
            put(key, value) {
                map.delete(key)  // remove first so existing keys don't trigger eviction
                if (map.size >= size) map.delete(map.keys().next().value)
                map.set(key, value)
            },
            get(key) {
                if (!map.has(key)) return null
                var value = map.get(key)
                map.delete(key)
                map.set(key, value)
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
            if (low_inclusive > high_inclusive) throw new Error('invalid range')

            var start_i = this._bs(mid => this.ranges[mid][1] >= low_inclusive - 1, this.ranges.length, true)
            var end_i = this._bs(mid => this.ranges[mid][0] <= high_inclusive + 1, -1, false)

            if (start_i > end_i)
                this.ranges.splice(start_i, 0, [low_inclusive, high_inclusive])
            else {
                var merged_low = Math.min(low_inclusive, this.ranges[start_i][0])
                var merged_high = Math.max(high_inclusive, this.ranges[end_i][1])
                this.ranges.splice(start_i, end_i - start_i + 1, [merged_low, merged_high])
            }
        }

        has(x, high) {
            if (high === undefined) high = x
            var index = this._bs(mid => this.ranges[mid][0] <= high, -1, false)
            return index !== -1 && x <= this.ranges[index][1] && this.ranges[index]
        }

        _bs(condition, default_r, move_left) {
            var lo = 0, hi = this.ranges.length - 1, result = default_r
            while (lo <= hi) {
                var mid = Math.floor((lo + hi) / 2)
                if (condition(mid)) {
                    result = mid
                    if (move_left) hi = mid - 1; else lo = mid + 1
                } else {
                    if (move_left) lo = mid + 1; else hi = mid - 1
                }
            }
            return result
        }
    }

    // -----------------------------------------------------------------------------
    // File Path Encoding Utilities (from url-file-db/canonical_path)
    // -----------------------------------------------------------------------------

    function encode_file_path_component(component) {
        // Encode characters that are unsafe on various filesystems:
        //   < > : " / \ | ? *  - Windows restrictions
        //   %                  - Reserved for encoding
        //   \x00-\x1f, \x7f    - Control characters
        var encoded = component.replace(/[<>:"|\\?*%\x00-\x1f\x7f/]/g, encode_char)

        // Encode Windows reserved filenames (con, prn, aux, nul, com1-9, lpt1-9)
        var windows_reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
        var match = component.match(windows_reserved)
        if (match) {
            var reserved_word = match[1]
            var last_char = reserved_word[reserved_word.length - 1]
            var encoded_reserved = reserved_word.slice(0, -1) + encode_char(last_char)
            var encoded_extension = encoded.slice(reserved_word.length)
            encoded = encoded_reserved + encoded_extension
        }

        // Encode trailing dots and spaces (stripped by Windows)
        if (encoded.endsWith('.') || encoded.endsWith(' ')) {
            var last_char = encoded[encoded.length - 1]
            encoded = encoded.slice(0, -1) + encode_char(last_char)
        }

        return encoded
    }

    function encode_to_avoid_icase_collision(component, existing_icomponents) {
        var icomponent = component.toLowerCase()

        while (existing_icomponents.has(icomponent)) {
            var found_letter = false

            // Find the last letter (a-zA-Z) that isn't part of a %XX encoding
            for (var i = component.length - 1; i >= 0; i--) {
                if (i >= 2 && component[i - 2] === '%') {
                    i -= 2
                    continue
                }

                var char = component[i]

                // Only encode letters - encoding non-letters doesn't help resolve case collisions
                if (!/[a-zA-Z]/.test(char)) {
                    continue
                }

                component = component.slice(0, i) + encode_char(char) + component.slice(i + 1)
                icomponent = component.toLowerCase()
                found_letter = true
                break
            }

            if (!found_letter) {
                throw new Error('Should never happen - safety check')
            }
        }

        return component
    }

    function encode_char(char) {
        return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
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

    function get_digest(s) {
        if (typeof s === 'string') s = Buffer.from(s, "utf8")
        return `sha-256=:${require('crypto').createHash('sha256').update(s).digest('base64')}:`
    }

    async function atomic_write(final_destination, data, temp_folder) {
        var temp = `${temp_folder}/${Math.random().toString(36).slice(2)}`
        await fs.promises.writeFile(temp, data)
        await fs.promises.rename(temp, final_destination)
    }

    function within_fiber(id, func) {
        if (!within_fiber.chains) within_fiber.chains = {}
        var prev = within_fiber.chains[id] || Promise.resolve()
        var curr = prev.then(async () => {
            try {
                return await func()
            } finally {
                if (within_fiber.chains[id] === curr)
                    delete within_fiber.chains[id]
            }
        })
        return within_fiber.chains[id] = curr
    }

    // Calls func(inner_signal, reconnect) immediately and handles reconnection.
    // - inner_signal: AbortSignal that aborts when reconnect() is called or outter_signal aborts
    // - reconnect(error): call this to trigger a reconnection after get_delay(error, count) ms
    // - Multiple/rapid reconnect() calls are safe - only one reconnection will be scheduled
    // - If outter_signal aborts, no further calls to func will occur
    function reconnector(outter_signal, get_delay, func) {
        if (outter_signal?.aborted) return

        var current_inner_ac = null
        outter_signal?.addEventListener('abort', () =>
            current_inner_ac?.abort())

        var reconnect_count = 0
        connect()
        function connect() {
            if (outter_signal?.aborted) return

            var ac = current_inner_ac = new AbortController()
            var inner_signal = ac.signal

            func(inner_signal, (e) => {
                if (outter_signal?.aborted ||
                    inner_signal.aborted) return

                ac.abort()
                var delay = get_delay(e, ++reconnect_count)
                setTimeout(connect, delay)
            })
        }
    }

    braid_text.get_resource = get_resource

    // Returns the number of connected subscribers for a resource
    braid_text.subscriber_count = async function(key) {
        if (!braid_text.cache[key]) return 0
        var resource = await braid_text.cache[key]
        return resource.clients().length
    }

    braid_text.db_folder_init = db_folder_init
    braid_text.encode_filename = encode_filename
    braid_text.decode_filename = decode_filename

    braid_text.dt_get = dt_get
    braid_text.dt_get_patches = dt_get_patches
    braid_text.dt_parse = dt_parse
    braid_text.dt_get_local_version = dt_get_local_version
    braid_text.dt_create_bytes = dt_create_bytes

    braid_text.decode_version = decode_version
    braid_text.RangeSet = RangeSet
    braid_text.braid_fetch = braid_fetch

    braid_text.create_braid_text = create_braid_text

    return braid_text
}


// Cursor lifecycle state for a single resource.
//
// Each peer's cursor is stored as:
//   cursors[peer_id] = { data: [{from, to}, ...], last_connected: timestamp }
//
// A cursor is "online" if the peer has an active subscription, OR if
// last_connected is within expiry_ms.  Expired entries are lazily
// cleaned on each snapshot.
//
// This is factored out so that the same logic could conceptually run
// on a client as well (e.g. for client-side filtering of stale cursors).
// Transform a single position through a delete+insert operation.
// Positions before the edit are unchanged; positions inside the deleted
// range collapse to the edit point; positions after shift by the net change.
// Pure inserts (del_len=0) push positions at the insert point forward.
function transform_pos(pos, del_start, del_len, ins_len) {
    if (del_len === 0) {
        // Pure insert: push positions at or after the insert point
        if (pos < del_start) return pos
        return pos + ins_len
    }
    if (pos <= del_start) return pos
    if (pos <= del_start + del_len) return del_start + ins_len
    return pos - del_len + ins_len
}

class cursor_state {
    constructor() {
        this.cursors = {}
        this.subscribers = new Set()
    }

    subscribed_peers() {
        var peers = new Set()
        for (var sub of this.subscribers)
            if (sub.peer) peers.add(sub.peer)
        return peers
    }

    broadcast(peer_id, data, exclude_peer) {
        var content = data != null ? JSON.stringify(data) : ''
        for (var sub of this.subscribers)
            if (sub.peer !== exclude_peer)
                try { sub.res.sendUpdate({
                    patch: {
                        unit: 'json',
                        range: '[' + JSON.stringify(peer_id) + ']',
                        content: content
                    }
                }) } catch (e) {}
    }

    snapshot() {
        var result = {}
        for (var [peer_id, cursor] of Object.entries(this.cursors))
            result[peer_id] = cursor.data
        return result
    }

    subscribe(subscriber) {
        this.subscribers.add(subscriber)
    }

    unsubscribe(subscriber) {
        this.subscribers.delete(subscriber)
        var peer_id = subscriber.peer
        if (peer_id && !this.subscribed_peers().has(peer_id)) {
            delete this.cursors[peer_id]
            this.broadcast(peer_id, null)
        }
    }

    // Transform all stored cursor positions through text patches.
    // Each patch has { range: [start, end], content_codepoints: [...] }.
    // Patches must be sorted by range[0] ascending (original coordinates).
    transform(patches) {
        if (!patches || !patches.length) return

        for (var cursor of Object.values(this.cursors)) {
            cursor.data = cursor.data.map(sel => {
                var from = sel.from
                var to = sel.to

                // Apply each patch's effect on positions, accumulating offset
                var offset = 0
                for (var p of patches) {
                    var del_start = p.range[0] + offset
                    var del_end = p.range[1] + offset
                    var del_len = del_end - del_start
                    var ins_len = p.content_codepoints.length

                    from = transform_pos(from, del_start, del_len, ins_len)
                    to = transform_pos(to, del_start, del_len, ins_len)

                    offset += ins_len - del_len
                }

                return {from, to}
            })
        }
    }

    put(peer_id, cursor_data) {
        if (!peer_id || !cursor_data) return false
        if (!this.subscribed_peers().has(peer_id)) return false
        this.cursors[peer_id] = { data: cursor_data }
        this.broadcast(peer_id, cursor_data, peer_id)
        return true
    }
}

// Handle cursor requests routed by content negotiation.
// Returns true if the request was handled, false to fall through.
async function handle_cursors(resource, req, res) {
    var accept = req.headers['accept'] || ''
    var content_type = req.headers['content-type'] || ''

    if (!accept.includes('application/text-cursors+json')
        && !content_type.includes('application/text-cursors+json'))
        return false

    res.setHeader('Content-Type', 'application/text-cursors+json')

    if (!resource.cursors) resource.cursors = new cursor_state()
    var cursors = resource.cursors
    var peer = req.headers['peer']

    if (req.method === 'GET' || req.method === 'HEAD') {
        if (!req.subscribe) {
            res.writeHead(200)
            if (req.method === 'HEAD')
                res.end()
            else
                res.end(JSON.stringify(cursors.snapshot()))
        } else {
            var subscriber = {peer, res}
            cursors.subscribe(subscriber)
            all_subscriptions.add(res)
            res.startSubscription({
                onClose: () => {
                    all_subscriptions.delete(res)
                    cursors.subscribers.delete(subscriber)
                    setTimeout(() => cursors.unsubscribe(subscriber), 0)
                }
            })
            res.sendUpdate({ body: JSON.stringify(cursors.snapshot()) })
        }
    } else if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
        var raw_body
        if (req.already_buffered_body != null) {
            raw_body = req.already_buffered_body.toString()
        } else {
            raw_body = await new Promise((resolve, reject) => {
                var chunks = []
                req.on('data', chunk => chunks.push(chunk))
                req.on('end', () => resolve(Buffer.concat(chunks).toString()))
                req.on('error', reject)
            })
        }
        var range = req.headers['content-range']
        if (!range || !range.startsWith('json ')) {
            res.writeHead(400)
            res.end('Missing Content-Range: json [<peer-id>] header')
            return true
        }
        var cursor_peer = JSON.parse(range.slice(5))[0]
        var accepted = cursors.put(cursor_peer, JSON.parse(raw_body))
        if (accepted) {
            res.writeHead(200)
            res.end()
        } else {
            res.writeHead(425)
            res.end('Peer not subscribed')
        }
    }

    return true
}

module.exports = create_braid_text()
