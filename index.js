#!/usr/bin/env node

var request = require('request');
var Q = require('q');
var rp = require('request-promise');
var URL_BASE = 'https://wwws.mint.com/';
var USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/35.0.1916.153 Safari/537.36';
var BROWSER = 'chrome';
var BROWSER_VERSION = 35;
var OS_NAME = 'mac';


module.exports = Prepare;
module.exports.setHttpService = SetHttpService;

// default http service factory
var _requestService = function(args) {
    return rp.defaults(args);
};

/**
 * Public "login" interface. Eg:
 * require('pepper-mint')(user, password)
 * .then(function(mint) {
 *  // do fancy stuff here
 * });
 */
function Prepare(email, password) {
    var mint = new PepperMint();

    return _login(mint, email, password);
}

/**
 * If you don't like `request` for whatever reason
 *  (it's unreasonably slow with node-webkit + angular,
 *  for some reason), you can provide a new one here.
 *
 * @param service the Factory for the http service. Called
 *  with {jar: cookieJar}, where the cookieJar is a
 *  request-compatible object containing the cookie jar.
 */
function SetHttpService(service) {
    _requestService = service;
    return module.exports;
}

/** wrap a Promise with JSON body parsing on success */
function _jsonify(promise) {
    return promise.then(function(body) {
        if (~body.indexOf("Session has expired."))
            throw new Error("Session has expired");

        try {
            return JSON.parse(body);
        } catch (e) {
            console.error("Unable to parse", body);
            throw e;
        }
    })
}

/* non-public login util function, so the credentials aren't saved on any object */
function _login(mint, email, password) {
    // get user pod (!?)
    // initializes some cookies, I guess;
    //  it does not appear to be necessary to
    //  load login.event?task=L
    return mint._form('getUserPod.xevent', {
        username: email
    })
    .then(function(json) {
        // save the pod number (or whatever) in a cookie
        var cookie = rp.cookie('mintPN=' + json.mintPN);
        mint.jar.setCookie(cookie, URL_BASE);

        // finally, login
        return mint._form('loginUserSubmit.xevent', {
            username: email
          , password: password
          , task: 'L'
          , browser: BROWSER
          , browserVersion: BROWSER_VERSION
          , os: OS_NAME
        });
    })
    .then(function(json) {
        if (json.error && json.error.vError)
            throw new Error(json.error.vError.copy);

        if (!(json.sUser && json.sUser.token))
            throw new Error("Unable to obtain token");

        mint.token = json.sUser.token;
        return mint;
    })
}

/**
 * Main public interface object
 */
function PepperMint() {
    this.requestId = 42; // magic number? random number?

    this.jar = rp.jar();
    this.rp = _requestService({jar: this.jar});
}

PepperMint.prototype.download = function() {
  return this._get('/transactionDownload.event');
}

/**
 * Returns a promise that fetches accounts
 */
PepperMint.prototype.getAccounts = function() {
    return this._jsonForm({
        args: {
            types: [
                "BANK",
                "CREDIT",
                "INVESTMENT",
                "LOAN",
                "MORTGAGE",
                "OTHER_PROPERTY",
                "REAL_ESTATE",
                "VEHICLE",
                "UNCLASSIFIED"
            ]
        },
        service: "MintAccountService",
        task: "getAccountsSorted"
    });
};

/**
 * Promised category list fetch
 */
PepperMint.prototype.getCategories = function() {
    return this._getJsonData('categories');
};

/**
 * Promised tags list fetch
 */
PepperMint.prototype.getTags = function() {
    return this._getJsonData('tags');
};



/**
 * Returns a promise that fetches transactions,
 *  optionally filtered by account and offset
 *
 * Args should look like: {
 *  accountId: 1234 // optional
 *  offset: 0 // optional
 * }
 */
PepperMint.prototype.getTransactions = function(args) {

    args = args || {};
    var offset = args.offset || 0;
    return this._getJsonData({
        accountId: args.accountId
      , offset: offset
      , comparableType: 8 // ?
      , acctChanged: 'T'  // ?
      , task: 'transactions'
    });
};

/**
 * Create a new cash transaction;
 *  to be used to fake transaction imports.
 *
 * NB: There is currently very little arg validation,
 *  and the server seems to silently reject issues, too :(
 *
 * Args should look like: {
 *  accountId: 1234 // apparently ignored, but good to have, I guess?
 *  amount: 4.2
 *  category: {
 *      id: id
 *    , name: name
 *  }
 *  date: "MM/DD/YYYY"
 *  isExpense: bool
 *  isInvestment: bool
 *  merchant: "Merchant Name"
 *  note: "Note, if any"
 *  tags: [1234, 5678] // set of ids
 * }
 *
 * @param category Optional; if not provided, will just show
 *  up as UNCATEGORIZED, it seems
 *
 */
PepperMint.prototype.createTransaction = function(args) {

    var self = this;
    var form = {
        amount: args.amount
      , cashTxnType: 'on'
      , date: args.date
      , isInvestment: args.isInvestment
      , merchant: args.merchant
      , mtAccount: args.accountId
      , mtCashSplitPref: 2              // ?
      , mtCheckNo: ''
      , mtIsExpense: args.isExpense
      , mtType: 'cash'
      , note: args.note
      , task: 'txnadd'
      , txnId: ':0'                     // might be required

      , token: this.token
    };

    if (args.category) {
        args.catId = args.category.id;
        args.category = args.category.name;
    }

    // set any tags requested
    if (Array.isArray(args.tags)) {
        args.tags.forEach(function(id) {
            form['tag' + id] = 2; // what? 2?!
        });
    }

    return self._form('updateTransaction.xevent', form);
};



/**
 * Delete a transaction by its id
 */
PepperMint.prototype.deleteTransaction = function(transactionId) {
    return this._form('updateTransaction.xevent', {
        task: 'delete',
        txnId: transactionId,
        token: this.token
    });
};

/*
 * Util methods
 */

PepperMint.prototype._get = function(url, qs) {
    var rp = this.rp;
    var fullUrl = URL_BASE + url;
    var args = {url: fullUrl};
    if (qs)
        args.qs = qs;
    return rp(args);
};

PepperMint.prototype._getJson = function(url, qs) {
    return _jsonify(this._get(url, qs));
};

/** Shortcut to fetch getJsonData of a single task */
PepperMint.prototype._getJsonData = function(args) {
    if ('string' === typeof(args))
        args = {task: args};
    args.rnd = this._random();

    return this._getJson('getJsonData.xevent', args)
    .then(function(json) {
        return json.set[0].data
    });
};


PepperMint.prototype._form = function(url, form) {
    var rp = this.rp;
    var fullUrl = URL_BASE + url;
    return _jsonify(rp({
        url: fullUrl
      , method: 'POST'
      , form: form
      , headers: {
            // Accept: 'application/json'
          // , 'User-Agent': USER_AGENT
          // , 'X-Request-With': 'XMLHttpRequest'
          // , 'X-NewRelic-ID': 'UA4OVVFWGwEGV1VaBwc='
          // , 'Referrer': 'https://wwws.mint.com/login.event?task=L&messageId=1&country=US&nextPage=overview.event'
        }
    }));
};

PepperMint.prototype._jsonForm = function(json) {
    var reqId = '' + this.requestId++;
    json.id = reqId;
    var url = 'bundledServiceController.xevent?legacy=false&token=' + this.token;

    return this._form(url, {
        input: JSON.stringify([json]) // weird
    }).then(function(resp) {
        if (!resp.response) {
            var task = json.service + "/" + json.task;
            throw new Error("Unable to parse response for " + task);
        }

        return resp.response[reqId].response;
    });
};

PepperMint.prototype._random = function() {
    return new Date().getTime();
};
