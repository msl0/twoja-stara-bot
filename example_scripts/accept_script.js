const MongoClient = require('mongodb').MongoClient;
const uri = "connection_string";
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
client.connect(err => {
    const collection = client.db("twoja-stara-prod").collection("Tweets");
    //all tweets from specified user
    collection.updateMany({ screen_name: "screen_name", UseDate: { $exists: false }, Accepted: false }, { $set: { Accepted: true } }, function (err, result) {
    console.log(result)
    })

    //one tweet from specified user
    collection.updateOne({ screen_name: "screen_name", UseDate: { $exists: false }, Accepted: false }, { $set: { Accepted: true } }, function (err, result) {
        console.log(result)
    })
    client.close();
});