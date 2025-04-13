
var port = process.argv[2] || 8889

var braid_text = require("../index.js")
braid_text.db_folder = null

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    // Free the CORS
    braid_text.free_cors(res)
    if (req.method === 'OPTIONS') return

    if (req.url.startsWith('/test.html')) {
        let parts = req.url.split(/[\?&=]/g)

        if (parts[1] === 'check') {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" })
            return res.end(JSON.stringify({
                checking: parts[2],
                result: (await braid_text.get(parts[2])) != null
            }))
        } else if (parts[1] === 'dt_create_bytes_big_name') {
            try {
                braid_text.dt_create_bytes('x'.repeat(1000000) + '-0', [], 0, 0, 'hi')
                return res.end(JSON.stringify({ ok: true }))
            } catch (e) {
                return res.end(JSON.stringify({ ok: false, error: '' + e }))
            }
        } else if (parts[1] === 'dt_create_bytes_many_names') {
            try {
                braid_text.dt_create_bytes('hi-0', new Array(1000000).fill(0).map((x, i) => `x${i}-0`), 0, 0, 'hi')
                return res.end(JSON.stringify({ ok: true }))
            } catch (e) {
                return res.end(JSON.stringify({ ok: false, error: '' + e }))
            }
        }

        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream(`${__dirname}/test.html`).pipe(res)
        return
    }

    // Now serve the collaborative text!
    braid_text.serve(req, res)
})

server.listen(port, () => {
    console.log(`serving: http://localhost:${port}/test.html`)
})
