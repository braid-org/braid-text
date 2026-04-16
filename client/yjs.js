// ******************************************************************
// Sync a YJS client, with a Y.Doc, through Braid-HTTP to a server
//
// This library requires yjs, lib0, braid-http-client.js


// === yjs_client ==
//
// This is the main function!
//
//  - It connects a Y.Doc to a remote Braid-HTTP URL.
//  - The "channel" is the channel of the ydoc that we are syncing.

function yjs_client(url, { ydoc, channel = 'text', headers: custom_headers,
                           on_update, on_error, onBytes, onFetch }) {

    if (typeof Y === 'undefined') throw new Error('yjs is not loaded')
    if (typeof braid_fetch === 'undefined') throw new Error('braid-http-client is not loaded')

    var peer = Math.random().toString(36).slice(2)
    var ac = new AbortController()
    var ytext = ydoc.getText(channel)
    var outstanding_puts = 0
    var max_outstanding_puts = 10

    // ── Subscribe (GET) ──
    braid_fetch(url, { peer, subscribe: true, retry: () => true, signal: ac.signal,
                       headers: { ...custom_headers, 'Merge-Type': 'yjs', },
                       onBytes, onFetch, }).then(res => {
        res.subscribe(async update => {
            if (!update.patches) return

            // Convert patches from wire format (content is bytes)
            var patches = update.patches
            for (var p of patches)
                if (p.content_text !== undefined) p.content = p.content_text

            // Convert yjs-text update to Yjs binary and apply
            try {
                var binary = to_yjs_binary([{ version: update.version, patches }])
                if (binary && binary.length > 0)
                    Y.applyUpdate(ydoc, binary, 'braid-http')
                if (on_update)
                    on_update()
            } catch (e) {
                console.error('yjs_client: failed to apply update:', e)
                if (on_error) on_error(e)
            }
        }, e => {
            if (on_error) on_error(e)
        })
    }).catch(e => {
        if (on_error) on_error(e)
    })

    // ── Local edits → PUT ──
    ydoc.on('update', (update, origin) => {
        if (origin === 'braid-http') return  // don't echo
        if (ac.signal.aborted) return
        if (outstanding_puts >= max_outstanding_puts) return

        try {
            var updates = from_yjs_binary(update)
            for (var u of updates) {
                outstanding_puts++
                braid_fetch(url, { method: 'PUT', peer,
                                   version: u.version, patches: u.patches,
                                   signal: ac.signal,
                                   retry: (res) => res.status !== 550,
                                   headers: { ...custom_headers, 'Merge-Type': 'yjs', },
                                   onBytes, onFetch })
                    .then(() => { outstanding_puts-- })
                    .catch(e => { outstanding_puts--; if (on_error) on_error(e) })
            }
        } catch (e) {
            console.error('yjs_client: failed to encode update:', e)
            if (on_error) on_error(e)
        }
    })

    return { abort: () => ac.abort() }
}

// ── from_yjs_binary: Yjs binary → yjs-text updates ──
function from_yjs_binary(update) {
    var decoded = Y.decodeUpdate(
        update instanceof Uint8Array ? update : new Uint8Array(update))
    var updates = []

    for (var struct of decoded.structs) {
        var text = struct.content?.str
        if (!text && struct.content?.len) text = '_'.repeat(struct.content.len)
        if (!text) continue
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

// Translates from Braid JSON updates into the YJS binary format 
function to_yjs_binary(updates) {
    var lib0_encoding = Y.lib0_encoding || (typeof lib0 !== 'undefined'
                                            ? lib0.encoding
                                            : require('lib0/encoding')),
        encoder = new Y.UpdateEncoderV1()

    var inserts_by_client = new Map(),
        deletes_by_client = new Map()

    for (var update of updates) {
        if (!update.patches) continue
        for (var p of update.patches) {
            var parsed = parse_yjs_range(p.range)
            if (!parsed) throw new Error('invalid yjs-text range: ' + p.range)

            if (p.content.length > 0) {
                var v_str = Array.isArray(update.version) ? update.version[0] : update.version
                if (!v_str) throw new Error('insert update requires version')
                var v_parts = v_str.match(/^(\d+)-(\d+)$/)
                if (!v_parts) throw new Error('invalid update version: ' + v_str)
                var item_id = { client: parseInt(v_parts[1]), clock: parseInt(v_parts[2]) }
                var list = inserts_by_client.get(item_id.client) || []
                list.push({ id: item_id, origin: parsed.left, rightOrigin: parsed.right, content: p.content })
                inserts_by_client.set(item_id.client, list)
            } else {
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
            var info = 4 | (has_origin ? 0x80 : 0) | (has_right_origin ? 0x40 : 0)
            encoder.writeInfo(info)
            if (has_origin) encoder.writeLeftID(Y.createID(item.origin.client, item.origin.clock))
            if (has_right_origin) encoder.writeRightID(Y.createID(item.rightOrigin.client, item.rightOrigin.clock))
            if (!has_origin && !has_right_origin) {
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
            lib0_encoding.writeVarUint(encoder.restEncoder, d.clock)
            lib0_encoding.writeVarUint(encoder.restEncoder, d.len)
        }
    }

    return encoder.toUint8Array()
}

function parse_yjs_range(range) {
    if (!range) return null
    var exclusive = range.match(/^\(([^)]*)\)$/)
    var inclusive = range.match(/^\[([^\]]*)\]$/)
    if (!exclusive && !inclusive) return null
    var inner = (exclusive || inclusive)[1]
    var parts = inner.split(':')
    if (parts.length !== 2) return null

    function parse_id(s) {
        if (!s) return null
        var m = s.match(/^(\d+)-(\d+)$/)
        return m ? { client: parseInt(m[1]), clock: parseInt(m[2]) } : null
    }

    var result = {
        inclusive: !!inclusive,
        left: parse_id(parts[0]),
        right: parse_id(parts[1])
    }

    if (inclusive && !result.left && !result.right) return null
    return result
}
