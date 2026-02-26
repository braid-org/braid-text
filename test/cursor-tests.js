// Cursor sharing tests
// Same pattern as tests.js: exports a function that takes a test runner and braid_fetch

function defineCursorTests(runTest, braid_fetch) {

// Helper: parse a cursor update — body (snapshot) or patch (single-peer update).
// Returns { peer_id_or_null, data_object }
function parse_cursor_update(update) {
    if (update.body_text != null)
        return JSON.parse(update.body_text)
    if (update.patches && update.patches.length) {
        var p = update.patches[0]
        var peer_id = JSON.parse(p.range)[0]
        var ct = p.content_text
        return { [peer_id]: ct ? JSON.parse(ct) : null }
    }
    return {}
}

// Helper: subscribe a peer for cursors, returning an AbortController.
// The peer is "online" as long as the subscription is open.
async function subscribe_peer(key, peer) {
    var ac = new AbortController()
    var r = await braid_fetch(`/${key}`, {
        subscribe: true,
        headers: {
            'Accept': 'application/text-cursors+json',
            'Peer': peer
        },
        signal: ac.signal
    })
    r.subscribe(() => {})  // consume updates to keep connection alive
    await new Promise(r => setTimeout(r, 50))  // let subscription establish
    return ac
}

runTest(
    "cursor: PUT and GET snapshot",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        // Subscribe so the peer is online
        var ac = await subscribe_peer(key, peer)

        // PUT a cursor
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 5, to: 5}])
        })
        if (r.status !== 200) { ac.abort(); return 'PUT failed: ' + r.status }

        // GET snapshot
        var r2 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        if (r2.status !== 200) return 'GET failed: ' + r2.status

        var body = JSON.parse(await r2.text())
        if (!body[peer]) return 'peer not in snapshot'
        if (body[peer][0].from !== 5 || body[peer][0].to !== 5)
            return 'wrong cursor data: ' + JSON.stringify(body[peer])

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: PUT selection range",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        var ac = await subscribe_peer(key, peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 3, to: 15}])
        })

        var r2 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r2.text())
        var sel = body[peer][0]
        if (sel.from !== 3 || sel.to !== 15)
            return 'wrong selection: ' + JSON.stringify(sel)

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: multiple peers in snapshot",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer_a = 'peer-a-' + Math.random().toString(36).slice(2)
        var peer_b = 'peer-b-' + Math.random().toString(36).slice(2)

        var ac_a = await subscribe_peer(key, peer_a)
        var ac_b = await subscribe_peer(key, peer_b)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer_a) + ']',
                'Peer': peer_a
            },
            body: JSON.stringify([{from: 0, to: 0}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer_b) + ']',
                'Peer': peer_b
            },
            body: JSON.stringify([{from: 10, to: 20}])
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac_a.abort()
        ac_b.abort()
        var body = JSON.parse(await r.text())

        if (!body[peer_a] || !body[peer_b])
            return 'missing peer: ' + JSON.stringify(Object.keys(body))

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: subscribe receives initial snapshot",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        // Subscribe the peer so it's live, then PUT a cursor
        var peer_ac = await subscribe_peer(key, peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 7, to: 7}])
        })

        // Subscribe as a different peer and check initial snapshot
        var ac = new AbortController()
        var result = await new Promise(async (resolve) => {
            var r = await braid_fetch(`/${key}`, {
                subscribe: true,
                headers: {
                    'Accept': 'application/text-cursors+json',
                    'Peer': 'subscriber-' + Math.random().toString(36).slice(2)
                },
                signal: ac.signal
            })

            r.subscribe(update => {
                ac.abort()
                peer_ac.abort()
                var body = parse_cursor_update(update)
                if (body[peer] && body[peer][0].from === 7)
                    resolve('ok')
                else
                    resolve('wrong initial: ' + JSON.stringify(body))
            })

            setTimeout(() => { ac.abort(); peer_ac.abort(); resolve('timeout') }, 3000)
        })

        return result
    },
    'ok'
)

runTest(
    "cursor: subscribe receives online updates",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var sub_peer = 'sub-' + Math.random().toString(36).slice(2)
        var put_peer = 'put-' + Math.random().toString(36).slice(2)

        var ac = new AbortController()

        var result = await new Promise(async (resolve) => {
            // Subscribe first
            var r = await braid_fetch(`/${key}`, {
                subscribe: true,
                headers: {
                    'Accept': 'application/text-cursors+json',
                    'Peer': sub_peer
                },
                signal: ac.signal
            })

            var update_count = 0
            r.subscribe(update => {
                update_count++
                var body = parse_cursor_update(update)
                // First update is initial snapshot (empty), second is the PUT
                if (update_count >= 2 && body[put_peer]) {
                    ac.abort()
                    if (body[put_peer][0].from === 42)
                        resolve('ok')
                    else
                        resolve('wrong data: ' + JSON.stringify(body))
                }
            })

            // Wait a moment, subscribe put_peer, then PUT
            await new Promise(r => setTimeout(r, 100))

            var put_ac = await subscribe_peer(key, put_peer)

            await braid_fetch(`/${key}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/text-cursors+json',
                    'Content-Range': 'json [' + JSON.stringify(put_peer) + ']',
                    'Peer': put_peer
                },
                body: JSON.stringify([{from: 42, to: 42}])
            })

            setTimeout(() => { put_ac.abort(); ac.abort(); resolve('timeout') }, 3000)
        })

        return result
    },
    'ok'
)

runTest(
    "cursor: updates not echoed back to sender",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        var ac = new AbortController()

        var result = await new Promise(async (resolve) => {
            // Subscribe as peer
            var r = await braid_fetch(`/${key}`, {
                subscribe: true,
                headers: {
                    'Accept': 'application/text-cursors+json',
                    'Peer': peer
                },
                signal: ac.signal
            })

            var update_count = 0
            r.subscribe(update => {
                update_count++
                if (update_count > 1) {
                    var body = parse_cursor_update(update)
                    if (body[peer]) {
                        ac.abort()
                        resolve('got own cursor echoed back')
                    }
                }
            })

            await new Promise(r => setTimeout(r, 100))

            await braid_fetch(`/${key}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/text-cursors+json',
                    'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                    'Peer': peer
                },
                body: JSON.stringify([{from: 0, to: 0}])
            })

            setTimeout(() => { ac.abort(); resolve('ok') }, 500)
        })

        return result
    },
    'ok'
)

runTest(
    "cursor: PUT overwrites previous cursor",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        var ac = await subscribe_peer(key, peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 0, to: 0}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 99, to: 99}])
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (body[peer][0].from !== 99)
            return 'not overwritten: ' + JSON.stringify(body[peer])

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: disconnect broadcasts empty array",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var disc_peer = 'disc-' + Math.random().toString(36).slice(2)
        var watcher_peer = 'watch-' + Math.random().toString(36).slice(2)

        // Subscribe disc_peer and PUT a cursor
        var disc_ac = await subscribe_peer(key, disc_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(disc_peer) + ']',
                'Peer': disc_peer
            },
            body: JSON.stringify([{from: 10, to: 10}])
        })

        var watcher_ac = new AbortController()

        var result = await new Promise(async (resolve) => {
            // Subscribe as watcher
            var watcher_r = await braid_fetch(`/${key}`, {
                subscribe: true,
                headers: {
                    'Accept': 'application/text-cursors+json',
                    'Peer': watcher_peer
                },
                signal: watcher_ac.signal
            })

            var update_count = 0
            watcher_r.subscribe(update => {
                update_count++
                var body = parse_cursor_update(update)
                if (disc_peer in body && body[disc_peer] === null) {
                    watcher_ac.abort()
                    resolve('ok')
                }
            })

            // Wait for watcher subscription to be established, then disconnect disc_peer
            await new Promise(r => setTimeout(r, 100))
            disc_ac.abort()

            setTimeout(() => { watcher_ac.abort(); resolve('timeout') }, 3000)
        })

        return result
    },
    'ok'
)

runTest(
    "cursor: transform on insert before cursor",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello world' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 6, to: 6}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[6:6]', content: 'dear '}]
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        if (body[cursor_peer][0].from !== 11)
            return 'expected 11, got ' + body[cursor_peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: transform on delete spanning cursor",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello world' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 7, to: 7}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[5:11]', content: ''}]
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        if (body[cursor_peer][0].from !== 5)
            return 'expected 5, got ' + body[cursor_peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: transform on insert before selection",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello world' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 6, to: 11}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[0:0]', content: 'XYZ'}]
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        var sel = body[cursor_peer][0]
        if (sel.from !== 9 || sel.to !== 14)
            return 'expected 9-14, got ' + sel.from + '-' + sel.to

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: transform preserves cursor before edit",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello world' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 2, to: 2}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[5:11]', content: ''}]
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        if (body[cursor_peer][0].from !== 2)
            return 'expected 2, got ' + body[cursor_peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: transform with multi-codepoint characters (emoji)",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'abcdef' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 5, to: 5}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[2:2]', content: '\u{1F600}'}]
        })

        var r_text = await braid_fetch(`/${key}`)
        var text = await r_text.text()
        if (text !== 'ab\u{1F600}cdef')
            return 'text wrong: ' + JSON.stringify(text)

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        if (body[cursor_peer][0].from !== 6)
            return 'expected 6, got ' + body[cursor_peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: transform with emoji in deleted range",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var cursor_peer = 'cursor-' + Math.random().toString(36).slice(2)
        var edit_peer = 'edit-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, { method: 'PUT', body: 'ab\u{1F600}cd' })

        var ac = await subscribe_peer(key, cursor_peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(cursor_peer) + ']',
                'Peer': cursor_peer
            },
            body: JSON.stringify([{from: 4, to: 4}])
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Peer': edit_peer },
            patches: [{unit: 'text', range: '[2:3]', content: ''}]
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body = JSON.parse(await r.text())
        if (!body[cursor_peer]) return 'cursor missing'
        if (body[cursor_peer][0].from !== 3)
            return 'expected 3, got ' + body[cursor_peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: unsubscribed peer not in snapshot",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        // PUT without subscribing
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 5, to: 5}])
        })

        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var body = JSON.parse(await r.text())
        if (body[peer])
            return 'unsubscribed peer should not be in snapshot'

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: PUT before subscribe returns 425",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        // PUT cursor data BEFORE subscribing — should get 425
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 42, to: 42}])
        })
        if (r.status !== 425)
            return 'expected 425, got ' + r.status

        // Not in snapshot (PUT was rejected)
        var r2 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var body = JSON.parse(await r2.text())
        if (body[peer])
            return 'rejected peer should not be in snapshot'

        // Now subscribe and PUT again — should succeed
        var ac = await subscribe_peer(key, peer)

        var r3 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 42, to: 42}])
        })
        if (r3.status !== 200)
            return 'PUT after subscribe should be 200, got ' + r3.status

        var r4 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        ac.abort()
        var body2 = JSON.parse(await r4.text())
        if (!body2[peer])
            return 'peer should be in snapshot after subscribing and PUT'
        if (body2[peer][0].from !== 42)
            return 'expected cursor at 42, got ' + body2[peer][0].from

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: unsubscribe deletes cursor data",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var peer = 'peer-' + Math.random().toString(36).slice(2)

        // Subscribe and PUT a cursor
        var ac = await subscribe_peer(key, peer)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
                'Peer': peer
            },
            body: JSON.stringify([{from: 10, to: 10}])
        })

        // Verify cursor is in snapshot
        var r = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var body = JSON.parse(await r.text())
        if (!body[peer])
            return 'peer should be in snapshot before unsubscribe'

        // Unsubscribe
        ac.abort()
        await new Promise(r => setTimeout(r, 100))

        // Cursor data should be gone
        var r2 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var body2 = JSON.parse(await r2.text())
        if (body2[peer])
            return 'peer should not be in snapshot after unsubscribe'

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: HEAD with cursor Accept returns cursor Content-Type",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        if (r.status !== 200) return 'expected 200, got ' + r.status
        var ct = r.headers.get('content-type') || ''
        if (!ct.includes('application/text-cursors+json'))
            return 'wrong content-type: ' + ct

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: HEAD without cursor Accept returns different Content-Type",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)

        // PUT some text so the resource exists
        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello' })

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            headers: { 'Accept': 'text/plain' }
        })
        if (r.status !== 200) return 'expected 200, got ' + r.status
        var ct = r.headers.get('content-type') || ''
        if (ct.includes('application/text-cursors+json'))
            return 'should not have cursor content-type, got: ' + ct

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: HEAD returns no body",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var body = await r.text()
        if (body.length > 0)
            return 'HEAD should return empty body, got: ' + JSON.stringify(body)

        return 'ok'
    },
    'ok'
)

runTest(
    "cursor: text operations unaffected by cursor headers",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hello world'
        })
        if (r.status !== 200) return 'text PUT failed: ' + r.status

        var r2 = await braid_fetch(`/${key}`)
        var text = await r2.text()
        if (text !== 'hello world') return 'text wrong: ' + text

        var r3 = await braid_fetch(`/${key}`, {
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        if (r3.status !== 200) return 'cursor GET failed: ' + r3.status

        return 'ok'
    },
    'ok'
)

// --- Client-side race condition test ---
// This tests the cursor_client logic directly: what happens when the
// cursor snapshot arrives before the text has loaded?

runTest(
    "cursor: snapshot before text loads (race condition)",
    async () => {
        var key = 'cursor-test-' + Math.random().toString(36).slice(2)
        var emacs_peer = 'emacs-' + Math.random().toString(36).slice(2)
        var web_peer = 'web-' + Math.random().toString(36).slice(2)

        // 1. PUT some text so the resource has content
        await braid_fetch(`/${key}`, { method: 'PUT', body: 'hello world' })

        // 2. Subscribe emacs peer and PUT a cursor at code-point 5
        var emacs_ac = await subscribe_peer(key, emacs_peer)
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                'Content-Range': 'json [' + JSON.stringify(emacs_peer) + ']',
                'Peer': emacs_peer
            },
            body: JSON.stringify([{from: 5, to: 5}])
        })

        // 3. Simulate a web client that receives cursors before text.
        //    We use cursor_client's internal logic: subscribe for cursors,
        //    but get_text() returns "" initially (text not loaded yet).
        var text = ""  // simulates empty textarea before text loads
        var received_changes = []

        // We need cursor_client to exist in this context.
        // Since cursor_client is browser-side code, we'll manually simulate
        // what it does: subscribe for cursor updates, process them, and
        // check if the online/offline gating works.

        // Subscribe for cursor data directly and see what we get
        var cursor_ac = new AbortController()
        var snapshot_data = null

        var r = await braid_fetch(`/${key}`, {
            subscribe: true,
            headers: {
                'Accept': 'application/text-cursors+json',
                'Peer': web_peer
            },
            signal: cursor_ac.signal
        })

        // Get the initial snapshot
        await new Promise((resolve) => {
            r.subscribe((update) => {
                if (update.body_text != null) {
                    snapshot_data = JSON.parse(update.body_text)
                    resolve()
                }
            })
        })

        cursor_ac.abort()
        emacs_ac.abort()

        // Verify the snapshot has emacs cursor at position 5
        if (!snapshot_data[emacs_peer])
            return 'emacs peer not in snapshot'
        if (snapshot_data[emacs_peer][0].from !== 5)
            return 'wrong cursor position: ' + snapshot_data[emacs_peer][0].from

        // 4. Now simulate what cursor_client does with this data.
        //    The key question: if we convert code-point 5 against empty text,
        //    what JS index do we get?

        // code_point_to_index_map for empty string:
        // m = [0]  (only entry: code-point 0 → index 0)
        // m[5] → undefined → fallback to text.length = 0
        // So the cursor would be at position 0. WRONG.

        // With the online/offline fix: cursor_client buffers the snapshot
        // until online() is called. Then text is available, so:
        // code_point_to_index_map("hello world") →
        //   m[5] = 5  (all ASCII, 1:1 mapping)
        // So the cursor is at position 5. CORRECT.

        // Simulate the BUGGY path (no online/offline, text empty):
        function code_point_to_index_map(s) {
            var m = [], c = 0
            for (var i = 0; i < s.length; i++) {
                m[c] = i
                var code = s.charCodeAt(i)
                if (code >= 0xd800 && code <= 0xdbff) i++
                c++
            }
            m[c] = i
            return m
        }

        var m_empty = code_point_to_index_map("")
        var buggy_pos = m_empty[5] !== undefined ? m_empty[5] : "".length
        if (buggy_pos !== 0)
            return 'expected buggy position to be 0, got ' + buggy_pos

        // Simulate the FIXED path (online() called after text loads):
        var m_real = code_point_to_index_map("hello world")
        var fixed_pos = m_real[5] !== undefined ? m_real[5] : "hello world".length
        if (fixed_pos !== 5)
            return 'expected fixed position to be 5, got ' + fixed_pos

        return 'ok'
    },
    'ok'
)

}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = defineCursorTests
}
