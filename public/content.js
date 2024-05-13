console.log("Loaded content.js")

window.addEventListener("message", (event) => {
    console.log(event)
    if (event.data.yakitex.msg && (event.data.yakitex.msg.type === "TEST")) {
        const name = event.data.yakitex.msg.fn_name
        const args = event.data.yakitex.msg.args
        const a = (fn, args) => {
            return window[fn](args)
        }
        const zz = a(name, args)
        console.log("res ", zz)
        window.postMessage({type: "FROM_PAGE", text: zz}, "*")
    }
},);