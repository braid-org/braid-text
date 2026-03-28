// textarea-highlights.js — Render colored highlights behind a <textarea>
//
// No dependencies. Pure DOM/CSS.
//
// Renders colored ranges (selections) and zero-width points (cursors) as
// overlays behind a textarea's text. Works with any textarea regardless
// of its parent's CSS — backdrops are positioned as absolute siblings.
//
// Usage:
//   var hl = textarea_highlights(textarea)
//   hl.set('peer-1', [{ from: 5, to: 10, color: '#61afef', bg_color: 'rgba(97,175,239,0.25)' }])
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
        var items = highlights.map(h => ({
            ...h,
            start: Math.min(h.from, h.to),
            end: Math.max(h.from, h.to)
        }))

        items.sort((a, b) => a.start - b.start)

        var result = ''
        var last = 0

        for (var item of items) {
            if (item.start < last) continue
            result += escape_html(text.substring(last, item.start))

            var cursor_html = '<span class="cursor" style="--cursor-color:' + item.color + ';"></span>'

            if (item.start === item.end) {
                result += cursor_html
            } else {
                var sel_html = escape_html(text.substring(item.start, item.end)).replace(/\n/g, ' \n')
                var before = item.to === item.start ? cursor_html : ''
                var after  = item.to === item.start ? '' : cursor_html
                result += '<span class="sel" style="background-color:' + item.bg_color + ';">' + before + sel_html + '</span>' + after
            }

            last = item.end
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
                ...h,
                from: Math.min(h.from, len),
                to: Math.min(h.to, len),
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

        destroy: function() {
            textarea.removeEventListener('scroll', sync_scroll)
            resize_observer.disconnect()
            for (var div of Object.values(layer_divs)) div.remove()
            layer_data = {}
            layer_divs = {}
            textarea.style.backgroundColor = original_bg
            textarea.style.position = original_position
            textarea.style.zIndex = original_zIndex
        }
    }
}
