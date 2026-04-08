// undo-sync.js -- Collaborative undo/redo for Braid-Text
//
// Implements the Loro-style OT-based undo algorithm:
//   https://github.com/loro-dev/loro/pull/361
//
// Core idea: undo is local-only (only reverts the current user's edits,
// not remote peers'). The undo stack stores inverse patches. When remote
// edits arrive, every entry in the undo/redo stack is transformed through
// them so positions stay valid.
//
// --- API ---
//
//   var um = undo_manager(get_state, apply, options)
//
//   get_state()
//       Returns the current text (e.g. () => textarea.value).
//
//   apply(patches)
//       Applies an array of patches to the document.
//       Patches are {range: [start, end], content: string} in JS-string indices.
//       You are responsible for feeding the result back to simpleton.changed().
//
//   options (all optional):
//     max_items:       max undo stack depth (default: 100)
//     capture_timeout: ms to group rapid edits (default: 500)
//
//   um.record(patches, text_before)
//       Call after each local edit with the patches that were applied and
//       the text BEFORE the edit.
//
//   um.transform(remote_patches)
//       Call whenever remote patches arrive (in your on_patches callback).
//       Keeps the undo/redo stack valid against the current document state.
//
//   um.undo()   -- undo the last local edit group, returns true if anything was undone
//   um.redo()   -- redo the last undone edit group, returns true if anything was redone
//
//   um.can_undo()  -- true if undo stack is non-empty
//   um.can_redo()  -- true if redo stack is non-empty
//
//   um.clear()  -- clear both stacks
//

function undo_manager(get_state, apply, options) {
    var max_items       = (options && options.max_items       != null) ? options.max_items       : 100
    var capture_timeout = (options && options.capture_timeout != null) ? options.capture_timeout : 500

    // Each stack entry is { inverse: {range, content}, ts: timestamp }.
    // One entry per patch (not merged). Grouping by capture_timeout is
    // handled at undo/redo time by popping consecutive entries within
    // the timeout window.
    var undo_stack = []
    var redo_stack = []

    // --- clone_patch ---
    // Deep-clone a patch so apply() can mutate ranges without corrupting
    // stored undo/redo entries.  apply_patches_and_update_selection does
    // p.range[0] += offset in-place.
    function clone_patch(p) {
        return { range: [p.range[0], p.range[1]], content: p.content }
    }

    // --- inverse ---
    // Given a forward patch {range: [s, e], content} applied to text_before,
    // return the patch that undoes it.
    function inverse_patch(patch, text_before) {
        var s = patch.range[0]
        var e = patch.range[1]
        var deleted = text_before.slice(s, e)
        return { range: [s, s + patch.content.length], content: deleted }
    }

    // --- transform_pos ---
    // Adjust a position through a single edit (same logic as cursor-sync.js).
    function transform_pos(pos, del_start, del_len, ins_len, bias) {
        if (del_len === 0) {
            if (pos < del_start) return pos
            if (pos === del_start && bias === 'left') return pos
            return pos + ins_len
        }
        if (pos <= del_start) return pos
        if (pos <= del_start + del_len) return del_start + ins_len
        return pos - del_len + ins_len
    }

    // --- transform_patch ---
    // Transform patch a through patch b so a is valid in b's post-state.
    function transform_patch(a, b) {
        var b_del_start = b.range[0]
        var b_del_len   = b.range[1] - b.range[0]
        var b_ins_len   = b.content.length

        // Start uses right bias (expand into inserts), end uses left bias
        // (don't expand delete range through co-located inserts).
        var new_start = transform_pos(a.range[0], b_del_start, b_del_len, b_ins_len, 'right')
        var new_end   = transform_pos(a.range[1], b_del_start, b_del_len, b_ins_len, 'left')
        if (new_end < new_start) new_end = new_start

        return { range: [new_start, new_end], content: a.content }
    }

    // --- transform_entries ---
    // Transform each stack entry through the remote patches independently.
    // Each entry was recorded at a different point in time (different text
    // state), so we cannot advance r through the stack (that assumes all
    // entries share a common coordinate space). Instead, each entry is
    // transformed through the original remote patches as-is.
    function transform_entries(entries, remote_patches) {
        for (var i = 0; i < entries.length; i++) {
            for (var r of remote_patches) {
                entries[i].inverse = transform_patch(entries[i].inverse, r)
            }
        }
    }

    // --- record ---
    function record(patches, text_before) {
        if (!patches || !patches.length) return

        var now = Date.now()
        var current_text = text_before

        for (var p of patches) {
            var inv = inverse_patch(p, current_text)
            undo_stack.push({ inverse: inv, ts: now })
            // Advance text through this forward patch for the next inverse
            var s = p.range[0], e = p.range[1]
            current_text = current_text.slice(0, s) + p.content + current_text.slice(e)
        }

        // Cap the stack
        while (undo_stack.length > max_items) undo_stack.shift()

        // New edit clears redo
        redo_stack = []
    }

    // --- transform ---
    function transform(remote_patches) {
        if (!remote_patches || !remote_patches.length) return
        transform_entries(undo_stack, remote_patches)
        transform_entries(redo_stack, remote_patches)
    }

    // --- collect_group ---
    // Pop entries from the top of `stack` that are within capture_timeout
    // of each other, returning them in the order they were pushed.
    function collect_group(stack) {
        if (!stack.length) return null
        var entries = [stack.pop()]
        while (stack.length > 0) {
            var top = stack[stack.length - 1]
            if (entries[0].ts - top.ts < capture_timeout) {
                entries.unshift(stack.pop())
            } else {
                break
            }
        }
        return entries
    }

    // --- undo ---
    function undo() {
        var group = collect_group(undo_stack)
        if (!group) return false

        var redo_entries = []
        for (var i = 0; i < group.length; i++) {
            var entry = group[i]
            var text_before = get_state()
            var redo_inv = inverse_patch(entry.inverse, text_before)
            apply([clone_patch(entry.inverse)])
            redo_entries.push({ inverse: redo_inv, ts: Date.now() })

            // Transform remaining entries through this undo patch so
            // their positions are valid against the new text state.
            for (var j = i + 1; j < group.length; j++) {
                group[j].inverse = transform_patch(group[j].inverse, entry.inverse)
            }
        }

        redo_stack.push.apply(redo_stack, redo_entries)
        return true
    }

    // --- redo ---
    function redo() {
        var group = collect_group(redo_stack)
        if (!group) return false

        var undo_entries = []
        for (var i = 0; i < group.length; i++) {
            var entry = group[i]
            var text_before = get_state()
            var undo_inv = inverse_patch(entry.inverse, text_before)
            apply([clone_patch(entry.inverse)])
            undo_entries.push({ inverse: undo_inv, ts: Date.now() })

            for (var j = i + 1; j < group.length; j++) {
                group[j].inverse = transform_patch(group[j].inverse, entry.inverse)
            }
        }

        undo_stack.push.apply(undo_stack, undo_entries)
        return true
    }

    return {
        record,
        transform,
        undo,
        redo,
        can_undo: function() { return undo_stack.length > 0 },
        can_redo: function() { return redo_stack.length > 0 },
        clear: function() { undo_stack = []; redo_stack = [] },
    }
}
