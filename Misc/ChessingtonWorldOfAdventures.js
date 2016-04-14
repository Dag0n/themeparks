var Park = require("../parkBase");

var moment = require("moment-timezone");
var crypto = require('crypto');
var random_useragent = require("random-useragent");
// cheerio, a jQuery-style HTML parser
var cheerio = require('cheerio');


module.exports = [ChessingtonWorldOfAdventures];

// timeout session after 15 minutes
var chessingtonSessionLength = 1000 * 60 * 15;
// timeout for schedule cache (20 hours)
var chessingtonScheduleDataCache = 1000 * 60 * 60 * 20;

function ChessingtonWorldOfAdventures(config) {
  // keep hold of 'this'
  var self = this;

  self.name = self.name || "Chessington World Of Adventures";

  // Alton Towers in London timezone
  self.park_timezone = "Europe/London";

  // base API URL to use for requests
  self.APIBase = self.APIBase || "https://legacy-api.attractions.io/apps/command/chessington/";
  // API key to access ride times
  self.APIKey = self.APIKey || "edqXyMWFtuqGY6BZ9Epkzg4ptqe6v3c7tdqa97VbXjvrgZHC";

  // Chessingon resort ID
  self.resort_id = "44";

  // grab opening times calendar from the website
  self.CalendarAPI = self.CalendarAPI || "https://www.chessington.com/plan/chessington-opening-times.aspx";

  // Call to parent class "Park" to inherit
  Park.call(self, config);

  // generate a random Android useragent
  self.RandomiseUseragent(function(ua) {
    return (ua.osName == "Android");
  });

  self._session = null;

  this.GetSession = function(callback) {
    // check for cached session
    if (self._session && self._session.expires && self._session.expires > Date.now()) {
      return callback(null, self._session.id);
    }

    // fetch new session token
    self.MakeNetworkRequest({
      "url": self.APIBase + "account",
      "method": "POST",
      "json": true,
    }, function(err, resp, data) {
      if (err) return self.Error("Error getting session token", err, callback);

      if (!data || !data.session) {
        return self.Error("Missing session token", data, callback);
      }

      // store session token in cache
      self._session = {
        id: data.session,
        expires: Date.now() + chessingtonSessionLength,
      };

      // return session token
      return callback(null, self._session.id);
    });
  };

  // create the response to a supplied challenge string
  this.ChallengeResponse = function(challenge) {
    return crypto.createHash('md5').update(challenge + self.APIKey).digest("hex");
  }

  // Get wait times
  this.GetWaitTimes = function(callback) {
    // get our session token
    self.GetSession(function(err, session_token) {
      if (err) return self.Error("Failed to get session token for wait times", err, callback);

      var timeNow = Date.now();

      // get challenge
      self.MakeNetworkRequest({
        "url": self.APIBase + "queue-times",
        "method": "POST",
        "formData": {
          "session": session_token,
          "resort": self.resort_id,
          "challenge": timeNow,
          "response": self.ChallengeResponse(timeNow),
        },
        "json": true
      }, function(err, resp, data) {
        if (err) return self.Error("Error fetching challenge string for wait times", err, callback);

        if (!data || !data.challenge) {
          return self.Error("Error reading challenge string from challenge request", data, callback);
        }

        var challenge = data.challenge;

        // now make actual wait times request
        self.MakeNetworkRequest({
          "url": self.APIBase + "queue-times",
          "method": "POST",
          "formData": {
            "session": session_token,
            "resort": self.resort_id,
            "challenge": challenge,
            "response": self.ChallengeResponse(challenge),
          },
          "json": true
        }, function(err, resp, data) {
          if (err) return self.Error("Failed to fetch wait times", err, callback);

          if (!data["queue-times"]) return self.Error("No queue times returned", data, callback);

          var rides = [];
          for (var i = 0, ride; ride = data["queue-times"][i++];) {
            rides.push({
              "id": ride.id,
              // TODO
              "name": null,
              "active": ride.is_operational,
              "waitTime": ride.wait_time || 0,
              "status": ride.is_operational ? "Operating" : "Closed",
              "fastPass": false,
            });
          }

          return callback(null, rides);
        });
      });
    });
  };

  self._scheduleCache = null;
  this.GetScheduleData = function(callback) {
    // check for cached schedule data
    if (self._scheduleCache && self._scheduleCache.expires && self._scheduleCache.expires >= Date.now()) {
      return callback(null, self._scheduleCache.data);
    }

    self.MakeNetworkRequest({
      "url": self.CalendarAPI,
    }, function(err, resp, html) {
      if (err) return self.Error("Unable to request calendar", err, callback);

      // load up HTML data
      $ = cheerio.load(html);

      var scheduleData = {};

      // find each div with class "day"
      var days = $(".day");
      for (var i = 0, day; day = days[i++];) {
        var el = $(day);
        // ignore "inactive" days (days that have already been)
        if (!el.hasClass("inactive")) {
          // extract date for this entry
          var timeStartDate = el.find("meta[itemprop=\"validFrom\"]").attr("content");
          var timeEndDate = el.find("meta[itemprop=\"validThrough\"]").attr("content");

          // if we have date meta data, extract opening and closing times
          if (timeStartDate && timeEndDate) {
            var openingString = moment.tz(el.find("meta[itemprop=\"opens\"]").attr("content"), "YYYY-MM-DDTHH:mm:ss", self.park_timezone).format(self.timeFormat);
            var closingString = moment.tz(el.find("meta[itemprop=\"closes\"]").attr("content"), "YYYY-MM-DDTHH:mm:ss", self.park_timezone).format(self.timeFormat);

            // work out time period to parse from this data
            var rangeStart = moment.tz(timeStartDate, "YYYY-MM-DD", self.park_timezone);
            var rangeEnd = moment.tz(timeEndDate, "YYYY-MM-DD", self.park_timezone);

            // add day for each date this period covers
            for (var date = rangeStart; date.isSameOrBefore(rangeEnd); date.add(1, "day")) {
              scheduleData[date.format("YYYYMMDD")] = {
                "date": date.format(self.dateFormat),
                "openingTime": openingString,
                "closingTime": closingString,
                "type": "Operating",
              };
            }
          }
        }
      }

      // store data in cache
      self._scheduleCache = {
        data: scheduleData,
        expires: Date.now() + chessingtonScheduleDataCache,
      }

      return callback(null, scheduleData);
    });
  };

  // get park opening times
  this.GetOpeningTimes = function(callback) {
    // get parsed schedule data
    self.GetScheduleData(function(err, data) {
      if (err) return self.Error("Error getting schedule data", err, callback);

      // work out days we want to get data between
      var today = moment().tz(self.park_timezone);
      var endDay = moment().add(self.scheduleMaxDates, 'days').tz(self.park_timezone);

      var schedule = [];

      for (var day = today; day.isSameOrBefore(endDay); day.add(1, "day")) {
        var dayData = data[day.format("YYYYMMDD")];
        if (dayData) {
          schedule.push(dayData);
        } else {
          schedule.push({
            "date": day.format(self.dateFormat),
            "type": "Closed",
          });
        }
      }

      return callback(null, schedule);
    });
  };
}

if (!module.parent) {
  var test = new ChessingtonWorldOfAdventures();
  test.GetScheduleData(console.log);
}