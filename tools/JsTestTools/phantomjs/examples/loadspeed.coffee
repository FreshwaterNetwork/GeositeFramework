if phantom.state.length is 0
    if phantom.args.length is 0
        console.log 'Usage: loadspeed.js <some URL>'
        phantom.exit()
    else
        address = phantom.args[0]
        phantom.state = Date.now().toString()
        console.log 'Loading ' + address
        phantom.open(address)
else
    elapsed = Date.now() - new Date().setTime(phantom.state)
    if phantom.loadStatus is 'success'
        console.log 'Page title is ' + document.title
        console.log 'Loading time ' + elapsed + ' msec'
    else
        console.log 'FAIL to load the address'
    phantom.exit()
