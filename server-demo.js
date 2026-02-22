var port = process.argv[2] || 8888
var braid_text = require("./server.js")

// TODO: set a custom database folder
// (the default is ./braid-text-db)
//
// braid_text.db_folder = './custom_db_folder'

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    // Free the CORS
    braid_text.free_cors(res)
    if (req.method === 'OPTIONS') return res.end()

    var q = req.url.split('?').slice(-1)[0]
    if (q === 'editor' || q === 'markdown-editor') {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream(`./client/${q}.html`).pipe(res)
        return
    }

    if (req.url === '/simpleton-sync.js' || req.url === '/web-utils.js'
        || req.url === '/cursor-highlights.js' || req.url === '/cursor-sync.js') {
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" })
        require("fs").createReadStream("./client" + req.url).pipe(res)
        return
    }

    // TODO: uncomment out the code below to add /pages endpoint,
    // which displays all the currently used keys
    // 
    // if (req.url === '/pages') {
    //     var pages = await braid_text.list()
    //     res.writeHead(200, {
    //         "Content-Type": "application/json",
    //         "Access-Control-Expose-Headers": "*"
    //     })
    //     res.end(JSON.stringify(pages))
    //     return
    // }

    // TODO: uncomment out the code below to add basic access control,
    // where a user logs in by openning the javascript console
    // and entering: document.cookie = 'fake_password'
    // 
    // var admin_pass = "fake_password"
    // 
    // if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
    //     if (!req.headers.cookie?.split(/;/).map(x => x.trim()).some(x => x === admin_pass)) {
    //         console.log("Blocked PUT:", { cookie: req.headers.cookie })
    //         res.statusCode = 401
    //         return res.end()
    //     }
    // }

    // Create some initial text for new documents
    if (!(await braid_text.get(req.url, {})).version.length) {
        await braid_text.put(req.url, {body: 'This is a fresh blank document, ready for you to edit.' })
    }

    // Now serve the collaborative text!
    braid_text.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on port ${port}`)
})
