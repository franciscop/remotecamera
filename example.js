var remotecamera = require('./index.js');

// Execute it with some error handling
remotecamera("http://httpbin.org/post", function(err, res, body){
  if (err) return console.log(err);
  if (res.statusCode !== 200) return console.log("Error: " + res.statusCode);
  console.log("Image posted!");
});

require('http').createServer().listen(3000);
