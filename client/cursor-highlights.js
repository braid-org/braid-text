// cursor-highlights.js — Render colored cursors and selections behind a <textarea>
//
// Usage:
//   var hl = textarea_highlights(textarea)
//   hl.set('peer-1', [{ from: 5, to: 10, color: 'rgba(97,175,239,0.25)' }])
//   hl.render()
//   hl.remove('peer-1')
//   hl.destroy()
//
function textarea_highlights(textarea) {
    // Inject CSS once per page
    if (!document.getElementById('textarea-highlights-css')) {
        var style = document.createElement('style')
        style.id = 'textarea-highlights-css'
        style.textContent = `
            .textarea-hl-backdrop {
                position: absolute;
                white-space: pre-wrap;
                word-wrap: break-word;
                overflow-y: auto;
                pointer-events: none;
                color: transparent;
                z-index: 1;
                box-sizing: border-box;
                scrollbar-width: none;
                -ms-overflow-style: none;
            }
            .textarea-hl-backdrop::-webkit-scrollbar { display: none; }
            .textarea-hl-backdrop span { color: transparent; border-radius: 2px; }
            .textarea-hl-backdrop span.sel {
                padding: var(--sel-pad, 3px) 0;
                -webkit-box-decoration-break: clone;
                box-decoration-break: clone;
            }
            .textarea-hl-backdrop .cursor {
                border-left: 2px solid var(--cursor-color, #ff5722);
                margin-left: -1px;
                margin-right: -1px;
            }
        `
        document.head.appendChild(style)
    }

    // Save original styles so we can restore on destroy
    var original_bg = textarea.style.backgroundColor
    var original_position = textarea.style.position
    var original_zIndex = textarea.style.zIndex

    // Read the textarea's background color before we make it transparent.
    // Walk up the DOM if the textarea itself is transparent.
    var bg = getComputedStyle(textarea).backgroundColor
    if (!bg || bg === 'rgba(0, 0, 0, 0)') {
        var el = textarea.parentElement
        while (el) {
            var elBg = getComputedStyle(el).backgroundColor
            if (elBg && elBg !== 'rgba(0, 0, 0, 0)') { bg = elBg; break }
            el = el.parentElement
        }
    }
    bg = bg || 'white'

    // Make textarea transparent so backdrops show through.
    // position:relative + z-index puts the textarea text above the backdrops.
    textarea.style.backgroundColor = 'transparent'
    textarea.style.position = 'relative'
    textarea.style.zIndex = '2'

    // Measure font metrics for gap-free selection highlights
    var cs = getComputedStyle(textarea)
    var test_div = document.createElement('div')
    test_div.style.cssText =
        'font-family:' + cs.fontFamily + ';' +
        'font-size:' + cs.fontSize + ';' +
        'line-height:' + cs.lineHeight + ';' +
        'position:absolute;top:-9999px;'
    var test_span = document.createElement('span')
    test_span.style.backgroundColor = 'red'
    test_span.textContent = 'Xg'
    test_div.appendChild(test_span)
    document.body.appendChild(test_div)
    var line_height = parseFloat(getComputedStyle(test_div).lineHeight)
    var bg_height = test_span.getBoundingClientRect().height
    document.body.removeChild(test_div)
    var sel_pad = (line_height - bg_height) / 2

    // State
    var layer_data = {}     // layer_id -> [{ from, to, color }]
    var layer_divs = {}     // layer_id -> DOM div

    // Scroll sync
    function sync_scroll() {
        for (var div of Object.values(layer_divs)) {
            div.scrollTop = textarea.scrollTop
            div.scrollLeft = textarea.scrollLeft
        }
    }
    textarea.addEventListener('scroll', sync_scroll)

    // Re-render when textarea resizes (user drag, window resize, CSS change)
    var resize_observer = new ResizeObserver(do_render)
    resize_observer.observe(textarea)

    // Build a backdrop style string matching the textarea's font/padding/border
    function backdrop_style() {
        var cs = getComputedStyle(textarea)
        var bw = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
        var bh = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
        // Use clientWidth/clientHeight (content + padding, excludes scrollbar)
        // plus border, so the backdrop's content area matches the textarea's
        // even when the textarea reserves space for a scrollbar.
        return 'font-family:' + cs.fontFamily + ';' +
            'font-size:' + cs.fontSize + ';' +
            'line-height:' + cs.lineHeight + ';' +
            'padding:' + cs.paddingTop + ' ' + cs.paddingRight + ' ' +
                cs.paddingBottom + ' ' + cs.paddingLeft + ';' +
            'border:' + cs.borderTopWidth + ' solid transparent;' +
            'border-radius:' + cs.borderRadius + ';' +
            'width:' + (textarea.clientWidth + bw) + 'px;' +
            'height:' + (textarea.clientHeight + bh) + 'px;' +
            '--sel-pad:' + sel_pad + 'px;' +
            'background-color:' + bg + ';'
    }

    function escape_html(text) {
        var div = document.createElement('div')
        div.textContent = text
        return div.innerHTML
    }

    function build_html(text, highlights) {
        var cursors = highlights.filter(h => h.from === h.to)
        var sels = highlights.filter(h => h.from !== h.to)

        var items = []
        for (var s of sels)
            items.push({ type: 'selection', start: s.from, end: s.to, color: s.color })
        for (var c of cursors)
            items.push({ type: 'cursor', pos: c.from, color: c.color })

        items.sort((a, b) => {
            var pa = a.type === 'cursor' ? a.pos : a.start
            var pb = b.type === 'cursor' ? b.pos : b.start
            return pa - pb
        })

        var result = ''
        var last = 0

        for (var item of items) {
            if (item.type === 'selection') {
                if (item.start < last) continue
                result += escape_html(text.substring(last, item.start))
                var sel_text = text.substring(item.start, item.end)
                var sel_html = escape_html(sel_text).replace(/\n/g, ' \n')
                result += '<span class="sel" style="background-color:' + item.color + ';">' + sel_html + '</span>'
                last = item.end
            } else {
                if (item.pos < last) continue
                result += escape_html(text.substring(last, item.pos))
                result += '<span class="cursor" style="--cursor-color:' + item.color + ';"></span>'
                last = item.pos
            }
        }

        result += escape_html(text.substring(last))
        if (text.endsWith('\n')) result += '\u200B\n'
        return result
    }

    // --- render implementation ---

    function do_render() {
        var text = textarea.value
        var len = text.length
        var style_str = backdrop_style()

        // Remove divs for layers that no longer exist
        for (var id of Object.keys(layer_divs)) {
            if (!layer_data[id]) {
                layer_divs[id].remove()
                delete layer_divs[id]
            }
        }

        // Render each layer
        for (var id of Object.keys(layer_data)) {
            var highlights = layer_data[id].map(h => ({
                from: Math.min(h.from, len),
                to: Math.min(h.to, len),
                color: h.color
            }))

            if (!layer_divs[id]) {
                // Insert backdrop as previous sibling of textarea.
                // position:absolute takes it out of flow so it doesn't
                // affect layout. Without top/left set, it naturally sits
                // at the textarea's position.
                var div = document.createElement('div')
                div.className = 'textarea-hl-backdrop'
                textarea.parentElement.insertBefore(div, textarea)
                layer_divs[id] = div
            }

            // Font/padding/border/size are set inline to match textarea;
            // positioning/pointer-events/etc come from the CSS class.
            layer_divs[id].style.cssText = style_str

            layer_divs[id].innerHTML = build_html(text, highlights)
            layer_divs[id].scrollTop = textarea.scrollTop
            layer_divs[id].scrollLeft = textarea.scrollLeft
        }
    }

    // --- show local cursor/selection when textarea is not focused ---

    var local_id = '__local__'

    function on_blur() {
        var from = textarea.selectionStart
        var to = textarea.selectionEnd
        var color = getComputedStyle(textarea).caretColor
        if (!color || color === 'auto') color = getComputedStyle(textarea).color
        if (from === to) {
            layer_data[local_id] = [{ from, to, color: color }]
        } else {
            var match = color.match(/(\d+),\s*(\d+),\s*(\d+)/)
            var sel_color = match ? 'rgba(' + match[1] + ', ' + match[2] + ', ' + match[3] + ', 0.3)' : color
            layer_data[local_id] = [{ from, to, color: sel_color }]
        }
        do_render()
    }

    function on_focus() {
        delete layer_data[local_id]
        if (layer_divs[local_id]) {
            layer_divs[local_id].remove()
            delete layer_divs[local_id]
        }
        do_render()
    }

    textarea.addEventListener('blur', on_blur)
    textarea.addEventListener('focus', on_focus)

    return {
        set: function(layer_id, highlights) {
            layer_data[layer_id] = highlights
        },

        remove: function(layer_id) {
            delete layer_data[layer_id]
            if (layer_divs[layer_id]) {
                layer_divs[layer_id].remove()
                delete layer_divs[layer_id]
            }
        },

        render: do_render,

        layers: function() {
            return Object.keys(layer_data)
        },

        destroy: function() {
            textarea.removeEventListener('scroll', sync_scroll)
            textarea.removeEventListener('blur', on_blur)
            textarea.removeEventListener('focus', on_focus)
            resize_observer.disconnect()
            for (var div of Object.values(layer_divs)) div.remove()
            layer_data = {}
            layer_divs = {}
            // Restore textarea styles
            textarea.style.backgroundColor = original_bg
            textarea.style.position = original_position
            textarea.style.zIndex = original_zIndex
        }
    }
}

// --- Color helpers ---

var _cursor_colors = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2"]

function peer_color(peer_id) {
    var hash = 0
    for (var i = 0; i < peer_id.length; i++)
        hash = ((hash << 5) - hash + peer_id.charCodeAt(i)) | 0
    return _cursor_colors[Math.abs(hash) % _cursor_colors.length]
}

function peer_bg_color(peer_id) {
    var c = peer_color(peer_id)
    var r = parseInt(c.slice(1, 3), 16)
    var g = parseInt(c.slice(3, 5), 16)
    var b = parseInt(c.slice(5, 7), 16)
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    return `rgba(${r}, ${g}, ${b}, ${dark ? 0.4 : 0.25})`
}

// --- High-level wrapper ---
//
// Usage:
//   var cursors = cursor_highlights(textarea, url)
//   cursors.on_patches(patches)   // call after applying remote patches
//   cursors.on_edit(patches)      // call after local edit; patches optional
//   cursors.destroy()
//
function cursor_highlights(textarea, url, options) {
    var peer = Math.random().toString(36).slice(2)
    var hl = textarea_highlights(textarea)
    var applying_remote = false
    var client = null
    var online = false
    var destroyed = false

    cursor_client(url, {
        peer,
        headers: options?.headers,
        get_text: () => textarea.value,
        on_change: (sels) => {
            for (var [id, ranges] of Object.entries(sels)) {
                if (!ranges.length) { hl.remove(id); continue }
                hl.set(id, ranges.map(r => ({
                    from: r.from, to: r.to,
                    color: r.from === r.to ? peer_color(id) : peer_bg_color(id)
                })))
            }
            hl.render()
        }
    }).then(function(c) {
        client = c
        if (online) client.online()
        if (destroyed) client.destroy()
    })

    function on_selectionchange() {
        if (applying_remote) return
        if (document.activeElement !== textarea) return
        if (client) client.set(textarea.selectionStart, textarea.selectionEnd)
    }
    document.addEventListener('selectionchange', on_selectionchange)

    return {
        online: function() {
            online = true
            if (client) client.online()
        },
        offline: function() {
            online = false
            if (client) client.offline()
        },

        on_patches: function(patches) {
            applying_remote = true
            if (client) client.changed(patches)
            hl.render()
            setTimeout(() => { applying_remote = false }, 0)
        },

        on_edit: function(patches) {
            if (client) {
                if (patches) client.changed(patches)
                client.set(textarea.selectionStart, textarea.selectionEnd)
            }
        },

        destroy: function() {
            destroyed = true
            document.removeEventListener('selectionchange', on_selectionchange)
            if (client) client.destroy()
            hl.destroy()
        }
    }
}
