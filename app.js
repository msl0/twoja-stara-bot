console.log("### Bot starting ###");
const request = require('request');
const util = require('util');
const get = util.promisify(request.get);
const post = util.promisify(request.post);
const express = require('express')
const bodyParser = require('body-parser')
const session = require('express-session')
const passport = require('passport')
const TwitterStrategy = require('passport-twitter')
const uuid = require('uuid/v4')
const security = require('./helpers/security')
const auth = require('./helpers/auth')
const cacheRoute = require('./helpers/cache-route')
const socket = require('./helpers/socket')
const assert = require('assert');
const MongoClient = require('mongodb').MongoClient;
const app = express();
var Twit = require('twit')

var T = new Twit({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token: process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  strictSSL: true     // optional - requires SSL certificates to be valid
})
var licznik = 1;
console.log(`[LOG] Every ${process.env.REPLY_AFTER_EVERY_X_MACHING_TWEETS} times`);
console.log(`[LOG] Filter-stream response enabled: ${process.env.FS_RESPONSE_ENABLED}`);
const url = 'mongodb+srv://' + process.env.DB_AUTH_USER + ':' + process.env.DB_AUTH_PASSWORD + "@" + process.env.DB_CONNECTION_STRING;
const bearerTokenURL = new URL('https://api.twitter.com/oauth2/token');
const streamURL = new URL('https://api.twitter.com/labs/1/tweets/stream/filter');
const rulesURL = new URL("https://api.twitter.com/labs/1/tweets/stream/filter/rules");
const consumer_key = process.env.TWITTER_CONSUMER_KEY;
const consumer_secret = process.env.TWITTER_CONSUMER_SECRET;
var MyScreenName = "ScreenNameUnknownYet"



function randomInt(low, high) {
  return Math.floor(Math.random() * (high - low + 1) + low)
}

// get sceen_name of connected account
function getMyScreenName() {
  //get screen_name and store in MyScreenName variable
  T.get('account/verify_credentials',
    function (err, data, response) {
      if (err) {
        console.log(err.message)
      } else {
        console.log("[LOG] ScreenName return: " + data.screen_name)
        return MyScreenName = data.screen_name
      }
    })
}

// send dm message
function sendDM(recipient_id, dm_message, screen_name) {
  console.log(`[DEBUG] recipient_id: ${recipient_id}, dm_message:  ${dm_message}, screen_name: ${screen_name}`)
  T.post('direct_messages/events/new',
    {
      "event":
      {
        "type": "message_create",
        "message_create":
        {
          "target":
            { "recipient_id": recipient_id },
          "message_data":
            { "text": dm_message }
        }
      }
    },
    function (err, data, response) {
      if (err) {
        console.log(err.message)
      } else {
        console.log(`[LOG] DM: ${screen_name} - ${data.event.message_create.message_data.text}, to "${recipient_id}"`)
      }
    })
}

// follow user
function follow(screen_name) {
  T.post('friendships/create',
    {
      "screen_name": screen_name
    },
    function (err, data, response) {
      if (err) {
        console.log(err.message)
      } else {
        if (screen_name == data.screen_name) {
          console.log(`[LOG] Followed: ${data.screen_name}"`)
        }
      }
    })
}

// unfollow user
function unfollow(screen_name) {
  T.post('friendships/destroy',
    {
      "screen_name": screen_name
    },
    function (err, data, response) {
      if (err) {
        console.log(err.message)
      } else {
        if (screen_name == data.screen_name) {
          console.log(`[LOG] Unfollowed: ${data.screen_name}"`)
        }
      }
    })
}

// mark DM message as read
function MarkRead(last_read_event_id, recipient_id) {
  T.post('direct_messages/mark_read',
    {
      'last_read_event_id': last_read_event_id,
      'recipient_id': recipient_id
    }, function (err, data, response) {
      if (err) {
        console.log(err.message)
      } else {
        console.log(data)
      }
    })
}

// get content of new tweet
const getTwit = function (db, callback) {
  const collection = db.collection('Tweets');
  var useDate = new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  collection.findOneAndUpdate(
    {
      UseDate: { $exists: false },
      Accepted: { $eq: true }
    },
    { $set: { UseDate: useDate } },
    function (err, docs) {
      assert.equal(err, null);
      callback(docs);
    });
}
function getData(err, data, response) {
  if (err)
    console.log("[LOG] Problem z wysłaniem tweeta\n" + err);
  else
    console.log(`[LOG] [ ${data.user.screen_name}, ID: ${data.user.id} ] Wysłano: "${data.text}"`);
}

// insert content of new tweet
const insertText = function (text, user, db, collection, callback) {
  var insertDate = new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const collect = db.collection(collection);
  collect.insertOne(
    {
      "Text": text,
      "User": user,
      "screen_name": user.screen_name,
      "user_id": user.id,
      "InsertDate": insertDate
    },
    function (err, result) {
      if (err) {
        assert.equal(err, null);
        assert.equal(1, result.result.n);
        assert.equal(1, result.ops.length);
      }
      callback(result);
    });
}

// return the number of tweets waiting for approval
const countWaitingTweets = function (user, db, callback) {
  const collection = db.collection('Tweets');
  collection.find(
    {
      "User.screen_name": user,
      "UseDate": { $exists: false },
      $or: [{ "Accepted": false }, { "Accepted": { $exists: false } }]
    }).count(function (err, result) {
      if (err) {
        assert.equal(err, null);
      }
      callback(result);
    });
}

// increase iteration rate - values used for refollow
function increateInteractionRate(user, event_type, multiplier) {
  var point = 0
  switch (event_type) {
    case 'favorite_events':
      point = 1;
      break;
    case 'follow_events':
      point = 3;
      break;
    case 'tweet_create_events':
      point = 5;
      break;
    case 'direct_message_events':
      point = 10;
      break;
  }
  if (multiplier !== undefined) {
    point = point * multiplier
  }
  const client = new MongoClient(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" });
  client.connect(function (err) {
    assert.equal(null, err);
    const db = client.db();
    db.collection('Users').updateOne(
      { "User": user },
      { $inc: { "InteractionRate": point } },
      { upsert: true },
      function (err, result) {
        assert.equal(1, result.result.n);
        if (err) {
          console.log("[ERROR] " + err)
        } else {
          console.log(`[LOG] Event type is ${event_type}, increateInteractionRate executed. Incremented interaction index by ${point} for user ${user}`);
        }
        client.close();
      }
    )
  })
}

// thank for messages via DM
function thanksForTweets() {
  function getUnique(arr, comp) {
    const unique = arr
      .map(e => e[comp])
      // store the keys of the unique objects
      .map((e, i, final) => final.indexOf(e) === i && i)
      // eliminate the dead keys & store unique objects
      .filter(e => arr[e]).map(e => arr[e]);
    return unique;
  }
  const client = new MongoClient(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" });
  // Use connect method to connect to the Server
  client.connect(function (err) {
    assert.equal(null, err);
    const db = client.db();
    db.collection('Tweets').find({ "Accepted": true, "Answered": { $exists: false } }, { projection: { '_id': 1, 'screen_name': 1, 'user_id': 1 } }).toArray(function (err, result) {
      assert.equal(null, err);
      if (result != null && result.length > 0) {
        // array of tweet ids
        const twtids = []
        for (const key in result) {
          twtids.push(result[key]._id)
        }
        // get message for response from db
        db.collection('DM_Messages').find({}).toArray(function (err, dm_messages) {
          // update documents, set answered to true
          db.collection('Tweets').updateMany({ '_id': { $in: twtids } }, { $set: { 'Answered': true } }, { upsert: true }, function (err, resp) {
            assert.equal(null, err);
            // count interaction points
            var points_obj = result.reduce((acc, o) => (acc[o.screen_name] = (acc[o.screen_name] || 0) + 1, acc), {});
            const points_entries = Object.entries(points_obj)
            // upload interaction points into db
            for (const [user, multiplier] of points_entries) {
              increateInteractionRate(user, 'direct_message_events', multiplier)
            }

            // upload interaction points
            client.close();
          });
          // array of unique users
          const unique_users = getUnique(result, 'user_id')
          console.log(`Counts of user to reply ${unique_users.length}, count of new accepted tweets ${result.length}`)
          //random delay
          var delay = randomInt(1, unique_users.length)
          // dm response loop
          for (const key in unique_users) {
            delay += parseInt(key)
            setTimeout(() => {
              var msg_number = randomInt(0, dm_messages.length - 1)
              // DM (element, ....)
              //sendDM(unique_users[key].user_id, `dziena za pomoc ${unique_users[key].screen_name}`, unique_users[key].screen_name)
              console.log(`[DEBUG] key: ${key}, unique_users:  ${unique_users}, dm_messages: ${dm_messages}`)
              console.log(`[DEBUG] msg_number: ${msg_number}, unique_users[key].user_id: ${unique_users[key].user_id}, dm_messages[msg_number]:  ${dm_messages[msg_number].Message}, unique_users[key].screen_name: ${unique_users[key].screen_name}`)
              sendDM(unique_users[key].user_id, dm_messages[msg_number].Message, unique_users[key].screen_name)
            }, 1000 * delay);
          }
        });
      } else {
        console.log(`[LOG] No tweets for response`),
          client.close();
      }
    });
  });
}
// follow x most active users and unfollow users which activiti is lower than x% comparing to last run
function refollow(follow_limit, unfollow_multiplier) {
  MongoClient.connect(url, { useUnifiedTopology: true }, function (err, db) {
    if (err) throw err;
    var dbo = db.db();
    dbo.collection('Audit').find({ "Type": "refollow", "Date": new Date().toLocaleDateString() }).toArray(function (err, result) {
      assert.equal(null, err)
      //console.log(result[0].Date)
      if (result.length == 0) {
        dbo.collection('Audit').insertOne({ "Type": "refollow", "Date": new Date().toLocaleDateString() }, function (err, result) {
          console.log(`[DEBUG] Inserted ${result.insertedCount} document to Audit collection`)
          dbo.collection("Users").find({ $or: [{ "Followed": { $exists: false } }, { "Followed": false }], "Special": { $exists: false }, "InteractionRate": { $exists: true } }, { sort: { "InteractionRate": -1 }, limit: follow_limit }).toArray(function (err, toFollow) {
            if (err) throw err;
            var follow_update = []
            if (toFollow.length > 0) {
              console.log(toFollow);
              var follow_update = toFollow.map(x => x._id)
              for (user in toFollow) {
                setTimeout(() => {
                  console.log(`[LOG] ${parseInt(user) + 1}. Follow: ${toFollow[user].User}`)
                  follow(toFollow[user].User)
                }, 1000 * randomInt(60, 180));
              }
            }
            else {
              console.log("[LOG] No users to follow")
            }
            dbo.collection("Users").find({ "Followed": true, "Special": { $exists: false }, "InteractionRate_Old": { $exists: true } }).toArray(function (err, toUnfollow) {
              var unfollow_update = []
              if (toUnfollow.length > 0) {
                console.log(toUnfollow);
                function removeActive(element, index, array) {
                  if (typeof element.InteractionRate == 'undefined') {
                    element.InteractionRate = 0
                  }
                  return (element.InteractionRate < element.InteractionRate_Old * unfollow_multiplier)
                }
                toUnfollow = toUnfollow.filter(removeActive);
                var unfollow_update = toUnfollow.map(x => x._id)
                for (user in toUnfollow) {
                  setTimeout(() => {
                    console.log(`[LOG] ${parseInt(user) + 1}. Unfollow: ${toUnfollow[user].User}`)
                    unfollow(toUnfollow[user].User)
                  }, 1000 * randomInt(60, 180));
                }
              } else {
                console.log("[LOG] No users to unfollow")
              }
              dbo.collection("Users").updateMany({}, { $rename: { "InteractionRate": "InteractionRate_Old" } }, function (err, res) {
                assert.equal(null, err);
                if (res.result.nModified == 0) {
                  console.log(`[ERROR] Move InteractionRate to InteractionRate_old - ${res.result.nModified} document(s) updated`);
                } else {
                  console.log(`[LOG] Move InteractionRate to InteractionRate_old - ${res.result.nModified} document(s) updated`);
                }
                db.close()
                if (follow_update.length > 0) {
                  MongoClient.connect(url, { useUnifiedTopology: true }, function (err, db) {
                    if (err) throw err;
                    var dbo = db.db();
                    dbo.collection("Users").updateMany({ '_id': { $in: follow_update } }, { $set: { 'Followed': true } }, { upsert: true }, function (err, res) {
                      assert.equal(null, err);
                      console.log(`[LOG] Followed ${res.result.nModified} new users`);
                      db.close()
                    })
                  })
                }
                if (unfollow_update.length > 0) {
                  MongoClient.connect(url, { useUnifiedTopology: true }, function (err, db) {
                    if (err) throw err;
                    var dbo = db.db();
                    dbo.collection("Users").updateMany({ '_id': { $in: unfollow_update } }, { $set: { 'Followed': false } }, function (err, res) {
                      assert.equal(null, err);
                      console.log(`[LOG] Unfollowed ${res.result.nModified} users`);
                      db.close();
                    })
                  })
                }
              })
            })
          });
        })
      } else {
        console.log("[LOG] refollow() has already been executed today")
        db.close()
      }
    })
  })
}

getMyScreenName();

app.set('port', (process.env.PORT || 5000))
app.set('views', __dirname + '/views')
app.set('view engine', 'ejs')

app.use(express.static(__dirname + '/public'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(passport.initialize());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}))

// start server
const server = app.listen(app.get('port'), function () {
  console.log('[LOG] Node app is running on port', app.get('port'))
})

// initialize socket.io
socket.init(server)

// form parser middleware
var parseForm = bodyParser.urlencoded({ extended: false })


/**
 * Receives challenge response check (CRC)
 **/
app.get('/webhook/twitter', function (request, response) {

  var crc_token = request.query.crc_token

  if (crc_token) {
    var hash = security.get_challenge_response(crc_token, auth.twitter_oauth.consumer_secret)

    response.status(200);
    response.send({
      response_token: 'sha256=' + hash
    })
  } else {
    response.status(400);
    response.send('Error: crc_token missing from request.')
  }
})


// send tweets section
var start_sched_hour = process.env.START_HOUR; //start time - twitts CAN be send after specified hour
var stop_sched_hour = process.env.START_STOP; //stop time - tweets CAN'T be send after specified hour

var tweetCountPerDay = process.env.TWEET_COUNT_PER_DAY
var randsendminutes = process.env.RANDOM_DELAY
var timeWindow = stop_sched_hour - start_sched_hour
var sendIntervalhour = timeWindow / tweetCountPerDay
console.log("[LOG] sendIntervalhour: " + sendIntervalhour)

setInterval(() => {
  console.log("[DEBUG] interval() - " + Date())
  //new rand value for timeout
  rand = Math.floor(Math.random() * (randsendminutes - 0 + 1) + 0)
  console.log("[DEBUG] rand additional minutes: " + rand)
  //get current hour
  var today = new Date().getHours();

  if (today >= start_sched_hour && today < stop_sched_hour) {
    setTimeout(() => {
      console.log("[DEBUG] timeout() - " + Date())
      const client = new MongoClient(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" });
      client.connect(function (err) {
        assert.equal(null, err);
        const db = client.db();
        getTwit(db, function (result) {
          client.close();
          if (result.value != null) {
            if (result.value.Text != null && result.value.Text.length > 1) {
              T.post('statuses/update', { status: result.value.Text }, getData);
              thanksForTweets();
              var dayofweek = new Date().getUTCDay()
              if (dayofweek == process.env.REFOLLOW_DAY_1 || dayofweek == process.env.REFOLLOW_DAY_2) {
                refollow(Number(process.env.FOLLOW_LIMIT), Number(process.env.UNFOLLOW_MULTIPLIER))
              }
            } else {
              console.log("[LOG] Text z getTweet() zwraca null")
            }
          } else {
            console.log("[LOG] Funkcja getTweet() zwraca null")
          }

        });
      });
    }, 1000 * 60 * rand);
  } else {
    console.log("[DEBUG] After working hours: " + start_sched_hour + " - " + stop_sched_hour)
  }
}, 1000 * 60 * 60 * sendIntervalhour);


// receive account events section
app.post('/webhook/twitter', function (request, response) {
  try {
    //console.log(request.body);
    //console.log('Received event: ' + Object.keys(request.body)[1] )
    switch (Object.keys(request.body)[1]) {
      case 'direct_message_events':

        var message = request.body.direct_message_events[0].message_create.message_data.text;
        var sender = Object.values(request.body.users)[0];
        if (message.length > process.env.MIN_LENGHT_OF_MESSAGE && sender.screen_name != MyScreenName && message.length <= 280) {
          console.log(request.body.direct_message_events[0].message_create.message_data)
          console.log(request.body.direct_message_events[0].message_create.message_data.entities)
          console.log(request.body.direct_message_events[0].message_create.message_data.attachment)
          const client = new MongoClient(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" });
          client.connect(function (err) {
            assert.equal(null, err);
            console.log("[LOG] Connected to DB [" + sender.screen_name + "]");
            const db = client.db();
            // Check waiting tweets
            countWaitingTweets(sender.screen_name, db, function (numWaitingTweets) {
              console.log("[LOG] " + sender.screen_name + " has " + numWaitingTweets + " tweets in pool.")
              if (numWaitingTweets < process.env.TWEETS_IN_QUEUE_PER_USER) {
                insertText(message, sender, db, 'Tweets', function (result) {
                  if (result.result.ok = 1) {
                    console.log("[LOG] " + sender.screen_name + " add: '" + message + "' to pool.")
                    client.close();
                    console.log("[LOG] Closed connection to DB [" + sender.screen_name + "]");

                    setTimeout(() => {
                      MarkRead(request.body.direct_message_events[0].id, sender.id)
                    }, 1000 * 60 * randomInt(5, 10));

                  } else {
                    console.log("[ERROR] Event add db error")
                  }
                });
              } else {
                console.log("[LOG] " + sender.screen_name + " reached waiting tweets limit(" + process.env.TWEETS_IN_QUEUE_PER_USER + ").");
                client.close();
                console.log("[LOG] Closed connection to DB [" + sender.screen_name + "]");
              }
            });
          });
        } else {
          console.log("[LOG] Tweet from " + sender.screen_name + " shorter than " + process.env.MIN_LENGHT_OF_MESSAGE + " letters or self create_message event or longer than 280 characters. Message lenght: " + message.length);
        }
        break;
      case 'favorite_events':
        if (request.body.favorite_events[0].user.screen_name != MyScreenName) {
          increateInteractionRate(request.body.favorite_events[0].user.screen_name, Object.keys(request.body)[1])
        }
        break;
      case 'follow_events':
        if (request.body.follow_events[0].source.screen_name != MyScreenName && request.body.follow_events[0].type == 'follow') {
          increateInteractionRate(request.body.follow_events[0].source.screen_name, Object.keys(request.body)[1])
        }
        break;
      case 'tweet_create_events':
        if (request.body.tweet_create_events[0].user.screen_name != MyScreenName) {
          increateInteractionRate(request.body.tweet_create_events[0].user.screen_name, Object.keys(request.body)[1])
        }
        break;
      default:
        console.log('Other event:' + Object.keys(request.body)[1])
        break;
    }

  } catch (e) {
    console.log(e);
  }

  socket.io.emit(socket.activity_event, {
    internal_id: uuid(),
    event: request.body
  })

  response.send('200 OK')
})


/**
 * Serves the home page
 **/
app.get('/', function (request, response) {
  response.render('index')
})


/**
 * Subscription management
 **/

auth.basic = auth.basic || ((req, res, next) => next())

app.get('/subscriptions', auth.basic, cacheRoute(1000), require('./routes/subscriptions'))


/**
 * Starts Twitter sign-in process for adding a user subscription
 **/
app.get('/subscriptions/add', passport.authenticate('twitter', {
  callbackURL: process.env.APP_URL + '/callbacks/addsub'
}));

/**
 * Starts Twitter sign-in process for removing a user subscription
 **/
app.get('/subscriptions/remove', passport.authenticate('twitter', {
  callbackURL: process.env.APP_URL + '/callbacks/removesub'
}));


/**
 * Webhook management routes
 **/
var webhook_view = require('./routes/webhook')
app.get('/webhook', auth.basic, auth.csrf, webhook_view.get_config)
app.post('/webhook/update', parseForm, auth.csrf, webhook_view.update_config)
app.post('/webhook/validate', parseForm, auth.csrf, webhook_view.validate_config)
app.post('/webhook/delete', parseForm, auth.csrf, webhook_view.delete_config)


/**
 * Activity view
 **/
app.get('/activity', auth.basic, require('./routes/activity'))


/**
 * Handles Twitter sign-in OAuth1.0a callbacks
 **/
app.get('/callbacks/:action', passport.authenticate('twitter', { failureRedirect: '/' }),
  require('./routes/sub-callbacks'))

async function sleep(delay) {
  return new Promise((resolve) =>
    setTimeout(() =>
      resolve(true), delay));
}

async function bearerToken(auth) {
  const requestConfig = {
    url: bearerTokenURL,
    auth: {
      user: consumer_key,
      pass: consumer_secret,
    },
    form: {
      grant_type: 'client_credentials',
    },
  };

  const response = await post(requestConfig);
  const body = JSON.parse(response.body);

  if (response.statusCode !== 200) {
    const error = body.errors.pop();
    throw Error(`Error ${error.code}: ${error.message}`);
    return null;
  }

  return JSON.parse(response.body).access_token;
}

async function getAllRules(token) {
  const requestConfig = {
    url: rulesURL,
    auth: {
      bearer: token
    }
  };

  const response = await get(requestConfig);
  if (response.statusCode !== 200) {
    throw new Error(response.body);
    return null;
  }

  return JSON.parse(response.body);
}

async function deleteAllRules(rules, token) {
  if (!Array.isArray(rules.data)) {
    return null;
  }

  const ids = rules.data.map(rule => rule.id);

  const requestConfig = {
    url: rulesURL,
    auth: {
      bearer: token
    },
    json: {
      delete: {
        ids: ids
      }
    }
  };

  const response = await post(requestConfig);
  if (response.statusCode !== 200) {
    throw new Error(JSON.stringify(response.body));
    return null;
  }

  return response.body;
}

async function setRules(rules, token) {
  const requestConfig = {
    url: rulesURL,
    auth: {
      bearer: token
    },
    json: {
      add: rules
    }
  };

  const response = await post(requestConfig);
  if (response.statusCode !== 201) {
    throw new Error(JSON.stringify(response.body));
    return null;
  }

  return response.body;
}


function streamConnect(token) {
  // Listen to the stream
  const config = {
    url: 'https://api.twitter.com/labs/1/tweets/stream/filter?format=compact',
    auth: {
      bearer: token,
    },
    timeout: 30000,
  };


  // filterstream sectionn
  const stream = request.get(config);
  stream.on('data', data => {
    try {
      const json = JSON.parse(data);
      console.log("[LOG] Filter counter: " + licznik);
      if (licznik % process.env.REPLY_AFTER_EVERY_X_MACHING_TWEETS == 0 && !json.connection_issue) {
        //console.log("[LOG] Filter counter: " + licznik);
        //T.post('statuses/update', { status: json.data.text, in_reply_to_status_id: json.data.id, auto_populate_reply_metadata: true}, getData);
        try {
          var replyDelay = randomInt(2, 6)
          console.log(`[LOG] Delay of reply: "${replyDelay}". Message: "${json.data.text}"`)
          setTimeout(() => {
            console.log(`[LOG] Reply to filtered message: "${json.data.text}" from ${json.data.author_id}`)
            MongoClient.connect(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" }, function (err, db) {
              if (err) throw err;
              var dbo = db.db();
              dbo.collection("Response").find({}).toArray(function (err, to_response) {
                if (err) throw err;
                if (to_response.length > 0) {
                  var fs_response = to_response[randomInt(0, to_response.length - 1)].Message;
                  console.log(`[TEST] to_response: ${fs_response}`)
                  if (parseInt(process.env.FS_RESPONSE_ENABLED)) {
                    T.post('statuses/update', { status: fs_response, in_reply_to_status_id: json.data.id, auto_populate_reply_metadata: true }, getData);
                  }
                } else {
                  console.log(`[TEST] No response message in db`)
                }
                db.close()
              })
            })
          }, 978 * 55 * replyDelay);
        } catch (e) {
          console.log("[LOG] " + json.data + " Exception message: " + e)

          const client = new MongoClient(url, { useUnifiedTopology: true, useNewUrlParser: true, appname: "bot" });
          client.connect(function (err) {
            assert.equal(null, err);
            const db = client.db();
            insertText(json, "debug", db, 'Debug', function (result) {
              client.close();
            });
          });
          console.log("[LOG] " + json + " Exception message: " + e)
        }

      }
      licznik++

      if (json.connection_issue || json.errors) {
        stream.emit('timeout');
        console.log(`[LOG] Error: ${json.connection_issue}`)
      }
    } catch (e) {
      console.log("[LOG] Heartbeat " + e)
    }

  }).on('error', error => {
    if (error.code === 'ESOCKETTIMEDOUT') {
      stream.emit('timeout');
    }
  });

  return stream;
}

var timeout = 0;
setInterval(() => {
  timeout = 0;
}, 1000 * 60 * 60 * 2);

(async () => {
  let token, currentRules, stream;
  const rules = [
    { 'value': process.env.RULE, 'tag': 'kurwa rule' },
  ];
  console.log(rules);
  try {
    // Exchange your credentials for a Bearer token
    token = await bearerToken({ consumer_key, consumer_secret });
  } catch (e) {
    console.error(`Could not generate a Bearer token. Please check that your credentials are correct and that the Filtered Stream preview is enabled in your Labs dashboard. (${e})`);
    process.exit(-1);
  }

  try {
    // Gets the complete list of rules currently applied to the stream
    currentRules = await getAllRules(token);

    // // Delete all rules. Comment this line if you want to keep your existing rules.
    await deleteAllRules(currentRules, token);

    // // Add rules to the stream. Comment this line if you want to keep your existing rules.
    await setRules(rules, token);
  } catch (e) {
    console.error(e);
    process.exit(-1);
  }

  // Listen to the stream.
  // This reconnection logic will attempt to reconnect when a disconnection is detected.
  // To avoid rate limites, this logic implements exponential backoff, so the wait time
  // will increase if the client cannot reconnect to the stream.
  const connect = () => {
    try {
      stream = streamConnect(token);
      stream.on('timeout', async () => {
        // Reconnect on error
        console.warn('A connection error occurred. Reconnecting…');
        timeout++;
        stream.abort();
        console.log("[LOG] Timeout: " + (2 ** timeout) * 10000);
        await sleep((2 ** timeout) * 10000);
        connect();
      });
    } catch (e) {
      connect();
    }
  }

  connect();
})();