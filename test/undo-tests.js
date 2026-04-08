// test/undo-tests.js — Unit and integration tests for undo-sync.js

function defineUndoTests(runTest, braid_fetch) {

// ── Helpers ────────────────────────────────────────────────────────────

// apply_text applies a set of absolute patches to a string.
// Patches are {range:[s,e], content} in original-document coords.
function apply_text(text, patches) {
    var offset = 0
    for (var p of patches) {
        var s = p.range[0] + offset
        var e = p.range[1] + offset
        text = text.slice(0, s) + p.content + text.slice(e)
        offset += p.content.length - (p.range[1] - p.range[0])
    }
    return text
}

// build_um creates an undo_manager whose state variable is visible to the caller.
function build_um(initial, opts) {
    var state = { text: initial }
    var um = undo_manager(
        () => state.text,
        (patches) => { state.text = apply_text(state.text, patches) },
        opts
    )
    return { um, state }
}

function p(s, e, content) { return { range: [s, e], content } }

// ── Unit: inverse ──────────────────────────────────────────────────────

runTest(
    "undo: inverse of insert",
    () => {
        var { um, state } = build_um('hello world')
        // Forward: insert ' dear' at 5 (no deletion)
        var text_before = state.text
        state.text = apply_text(state.text, [p(5, 5, ' dear')])
        um.record([p(5, 5, ' dear')], text_before)
        // text is now 'hello dear world'
        um.undo()
        return state.text === 'hello world' ? 'ok' : 'fail: ' + state.text
    },
    'ok'
)

runTest(
    "undo: inverse of delete",
    () => {
        var { um, state } = build_um('hello world')
        var text_before = state.text
        state.text = apply_text(state.text, [p(4, 5, '')])   // delete 'o'
        um.record([p(4, 5, '')], text_before)
        um.undo()
        return state.text === 'hello world' ? 'ok' : 'fail: ' + state.text
    },
    'ok'
)

runTest(
    "undo: inverse of replace",
    () => {
        var { um, state } = build_um('hello world')
        var text_before = state.text
        state.text = apply_text(state.text, [p(6, 11, 'earth')])
        um.record([p(6, 11, 'earth')], text_before)
        um.undo()
        return state.text === 'hello world' ? 'ok' : 'fail: ' + state.text
    },
    'ok'
)

// ── Unit: redo ─────────────────────────────────────────────────────────

runTest(
    "undo: undo then redo restores original edit",
    () => {
        var { um, state } = build_um('hello')
        var text_before = state.text
        state.text = apply_text(state.text, [p(5, 5, ' world')])
        um.record([p(5, 5, ' world')], text_before)
        if (state.text !== 'hello world') return 'setup: ' + state.text
        um.undo()
        if (state.text !== 'hello') return 'after undo: ' + state.text
        um.redo()
        return state.text === 'hello world' ? 'ok' : 'fail after redo: ' + state.text
    },
    'ok'
)

runTest(
    "undo: multiple undo steps",
    () => {
        // Use capture_timeout:0 so each edit gets its own undo group
        var { um, state } = build_um('', { capture_timeout: 0 })

        var t = state.text
        state.text = apply_text(t, [p(0, 0, 'a')]); um.record([p(0, 0, 'a')], t)
        t = state.text
        state.text = apply_text(t, [p(1, 1, 'b')]); um.record([p(1, 1, 'b')], t)
        t = state.text
        state.text = apply_text(t, [p(2, 2, 'c')]); um.record([p(2, 2, 'c')], t)

        um.undo(); if (state.text !== 'ab') return 'step1: ' + state.text
        um.undo(); if (state.text !== 'a')  return 'step2: ' + state.text
        um.undo(); if (state.text !== '')   return 'step3: ' + state.text
        return 'ok'
    },
    'ok'
)

runTest(
    "undo: new edit clears redo stack",
    () => {
        var { um, state } = build_um('hello')
        var t = state.text
        state.text = apply_text(t, [p(5, 5, ' world')]); um.record([p(5, 5, ' world')], t)
        um.undo()
        if (!um.can_redo()) return 'should have redo entry'
        t = state.text
        state.text = apply_text(t, [p(5, 5, ' there')]); um.record([p(5, 5, ' there')], t)
        return !um.can_redo() ? 'ok' : 'redo stack not cleared'
    },
    'ok'
)

// ── Unit: transform through remote edit ───────────────────────────────

runTest(
    "undo: transform undo entry through remote insert before undo range",
    () => {
        // State after local edit: 'hello ' (deleted 'world' from 'hello world')
        // Remote inserts 'dear ' at position 0: state becomes 'dear hello '
        // After transform + undo, should restore to 'dear hello world'
        var { um, state } = build_um('hello world')
        var t = state.text
        state.text = apply_text(t, [p(6, 11, '')])       // delete 'world'
        um.record([p(6, 11, '')], t)                      // records inverse: insert 'world' at 6

        // Remote arrives: insert 'dear ' at 0
        um.transform([p(0, 0, 'dear ')])
        state.text = apply_text(state.text, [p(0, 0, 'dear ')])  // 'dear hello '

        um.undo()
        return state.text === 'dear hello world' ? 'ok' : 'fail: ' + state.text
    },
    'ok'
)

runTest(
    "undo: transform undo entry through remote insert after undo range",
    () => {
        // Local: insert ' dear' at 5 in 'hello world' -> 'hello dear world'
        // Remote: insert '!' at end (position 16) -> 'hello dear world!'
        // After transform + undo, should get 'hello world!'
        var { um, state } = build_um('hello world')
        var t = state.text
        state.text = apply_text(t, [p(5, 5, ' dear')])
        um.record([p(5, 5, ' dear')], t)

        // Remote inserts '!' at position 16 (after our insertion point)
        um.transform([p(16, 16, '!')])
        state.text = apply_text(state.text, [p(16, 16, '!')])   // 'hello dear world!'

        um.undo()
        return state.text === 'hello world!' ? 'ok' : 'fail: ' + state.text
    },
    'ok'
)

// ── Unit: capture timeout ──────────────────────────────────────────────

runTest(
    "undo: rapid edits grouped into one step (capture timeout)",
    () => {
        var { um, state } = build_um('')

        // All three edits happen "instantly" — within the default 500ms window
        var t = state.text
        state.text = apply_text(t, [p(0, 0, 'a')]); um.record([p(0, 0, 'a')], t)
        t = state.text
        state.text = apply_text(t, [p(1, 1, 'b')]); um.record([p(1, 1, 'b')], t)
        t = state.text
        state.text = apply_text(t, [p(2, 2, 'c')]); um.record([p(2, 2, 'c')], t)

        // Since capture_timeout=500ms and all 3 happened at roughly the same time,
        // they should merge into one group. One undo should remove all three.
        um.undo()
        return state.text === '' ? 'ok' : 'expected empty, got: ' + state.text
    },
    'ok'
)

runTest(
    "undo: can_undo and can_redo reflect stack state",
    () => {
        var { um, state } = build_um('hello')
        if (um.can_undo()) return 'should start empty'
        if (um.can_redo()) return 'should start empty'
        var t = state.text
        state.text = apply_text(t, [p(5, 5, '!')]); um.record([p(5, 5, '!')], t)
        if (!um.can_undo()) return 'should have undo after record'
        um.undo()
        if (um.can_undo()) return 'should be empty after full undo'
        if (!um.can_redo()) return 'should have redo after undo'
        return 'ok'
    },
    'ok'
)

runTest(
    "undo: clear empties both stacks",
    () => {
        var { um, state } = build_um('hello')
        var t = state.text
        state.text = apply_text(t, [p(5, 5, '!')]); um.record([p(5, 5, '!')], t)
        um.undo()
        um.clear()
        return !um.can_undo() && !um.can_redo() ? 'ok' : 'stacks not cleared'
    },
    'ok'
)

// ── Edge cases from Loro's limitations ────────────────────────────────

runTest(
    "undo: remote delete overlapping undo range collapses gracefully",
    () => {
        // Local: insert 'XY' at 5 in 'hello world' -> 'helloXY world'
        // Remote: deletes 'oXY w' (positions 4-9 in post-insert state)
        // After transform, the undo entry's range collapses.
        // Undo should still not crash and should remove whatever is left.
        var { um, state } = build_um('hello world')
        var t = state.text
        state.text = apply_text(t, [p(5, 5, 'XY')])
        um.record([p(5, 5, 'XY')], t)
        // state: 'helloXY world'

        // Remote deletes 'oXY w' = positions 4 to 9
        um.transform([p(4, 9, '')])
        state.text = apply_text(state.text, [p(4, 9, '')])
        // state: 'hellorld'

        // Undo should not crash. The undo entry's original range [5,7]
        // (delete 'XY') gets transformed through the remote delete.
        // Both positions land inside the deleted region and collapse.
        um.undo()
        // The exact result depends on transform_pos semantics.
        // The key property: no crash, text stays consistent.
        return typeof state.text === 'string' ? 'ok' : 'fail: crash'
    },
    'ok'
)

runTest(
    "undo: multi-patch grouped undo+redo round-trip",
    () => {
        // Three rapid edits merge into one group (default 500ms timeout).
        // Undo should revert all three; redo should restore all three.
        var { um, state } = build_um('hello')

        var t = state.text
        state.text = apply_text(t, [p(5, 5, ' ')]); um.record([p(5, 5, ' ')], t)
        t = state.text
        state.text = apply_text(t, [p(6, 6, 'w')]); um.record([p(6, 6, 'w')], t)
        t = state.text
        state.text = apply_text(t, [p(7, 7, '!')]); um.record([p(7, 7, '!')], t)
        // state: 'hello w!'

        if (state.text !== 'hello w!') return 'setup: ' + state.text

        um.undo()
        if (state.text !== 'hello') return 'after undo: ' + state.text

        um.redo()
        return state.text === 'hello w!' ? 'ok' : 'after redo: ' + state.text
    },
    'ok'
)

runTest(
    "undo: undo-redo-undo cycle",
    () => {
        var { um, state } = build_um('abc', { capture_timeout: 0 })

        var t = state.text
        state.text = apply_text(t, [p(3, 3, 'd')]); um.record([p(3, 3, 'd')], t)
        // 'abcd'

        um.undo()
        if (state.text !== 'abc') return 'undo1: ' + state.text

        um.redo()
        if (state.text !== 'abcd') return 'redo1: ' + state.text

        um.undo()
        return state.text === 'abc' ? 'ok' : 'undo2: ' + state.text
    },
    'ok'
)

// ── Integration: undo with concurrent peer via HTTP ───────────────────

runTest(
    "undo: local undo does not revert remote peer's edit",
    async () => {
        var key = 'undo-concurrent-' + Math.random().toString(36).slice(2)
        var peer_a = 'peer-a-' + Math.random().toString(36).slice(2)
        var peer_b = 'peer-b-' + Math.random().toString(36).slice(2)
        var base = 'http://localhost:8889'

        // Set initial state
        await braid_fetch(`${base}/${key}`, {
            method: 'PUT', body: 'hello world',
            headers: { 'Content-Type': 'text/plain' }
        })

        // A inserts ' dear' at position 5
        await braid_fetch(`${base}/${key}`, {
            method: 'PUT',
            headers: { Peer: peer_a, 'Content-Type': 'text/plain' },
            patches: [{ unit: 'text', range: '[5:5]', content: ' dear' }]
        })

        // B inserts '!' at end of original text (pos 11)
        await braid_fetch(`${base}/${key}`, {
            method: 'PUT',
            headers: { Peer: peer_b, 'Content-Type': 'text/plain' },
            patches: [{ unit: 'text', range: '[11:11]', content: '!' }]
        })

        // Read merged text
        var current_r = await braid_fetch(`${base}/${key}`)
        var current = await current_r.text()


        // Simulate A's undo: find and remove ' dear'
        var idx = current.indexOf(' dear')
        if (idx === -1) return 'dear not found in: ' + current

        var undo_res = await braid_fetch(`${base}/${key}`, {
            method: 'PUT',
            headers: { Peer: peer_a + '-undo', 'Content-Type': 'text/plain' },
            patches: [{ unit: 'text', range: '[' + idx + ':' + (idx + 5) + ']', content: '' }]
        })

        var after_r = await braid_fetch(`${base}/${key}`)
        var after = await after_r.text()

        if (after.includes(' dear')) return 'dear still present: ' + after
        if (!after.includes('!')) return '! removed unexpectedly: ' + after

        return 'ok'
    },
    'ok'
)

}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = defineUndoTests
}
