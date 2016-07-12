/**
 * Augur market monitor
 * @author Jack Peterson (jack@tinybike.net), Keivn Day (@k_day)
 */

"use strict";

var async = require("async");
var levelup = require('levelup');
var sublevel = require('level-sublevel')

var INTERVAL = 600000; // default update interval (10 minutes)
var noop = function () {};

module.exports = {

    debug: false,

    db: null,
    dbMarketInfo: null,
    marketsInfo: null,
    
    augur: require("augur.js"),

    watcher: null,

    //List of market properties to cache
    marketProps: {tradingPeriod:1, tradingFee:1, creationTime:1, volume:1, tags:1, endDate:1, description:1, makerFee:1, takerFee:1},

    connect: function (config, callback) {
        var self = this;
        callback = callback || noop;

        self.augur.connect(config, () => {
            if (config.leveldb){
                levelup(config.leveldb, (err, db) => {
                    if (err) return callback(err);
                    self.db = sublevel(db);
                    self.dbMarketInfo = self.db.sublevel('markets');
                    self.populateMarkets(self.dbMarketInfo, (err) => {
                        if (err) return callback(err);
                        return callback(null);
                    });
                });
            }
        });
    },

    //deserialize db into memory
    populateMarkets: function(marketDB, callback){
        var self = this;
        self.marketsInfo = {};
        if (!marketDB) return callback("db not found");

        marketDB.createReadStream({valueEncoding: 'json'})
        .on('data', (data) => {
            if (!data.value.branchId){
                return callback('populateMarkets Error: branch not found');
            }
            var branch = data.value.branchId;
            self.filterProps(data.value);
            data.value.tradingFee = self.augur.getTradingFee(data.key);
            self.marketsInfo[branch] = self.marketsInfo[branch] || {};
            self.marketsInfo[branch][data.key] = data.value;
        }).on('error', (err) => {
            return callback('populateMarkets Error:', err);
        }).on('end', () => {
            return callback(null);
        });
    },

    disconnect: function (callback) {
        var self = this;
        callback = callback || function (e, r) { console.log(e, r); };

        if (!self.db || typeof self.db !== "object"
             || !self.dbMarketInfo || typeof self.dbMarketInfo !== "object"){
            return callback("db not found");
        }
        self.db.close( (err) => {
            if (err) return callback(err);
            self.db = null;
            self.dbMarketInfo = null;
            self.marketsInfo = {};
            return callback(null);
        });
    },

    remove: function (id, callback) {
        var self = this;
        if (!self.dbMarketInfo) return callback("db not found");
        if (!self.marketsInfo) return callback("marketsInfo not loaded");
        
        //TODO: fetch to get branch, delete, delete from mem.
        self.dbMarketInfo.del(id, (err) => {
            if (err) return callback(err);
            delete self.marketsInfo[id];
            return callback(null);
        });
    },

    // select market using market ID
    getMarketInfo: function (id, callback) {
        var self = this;
        if (!id) return callback("no market specified");
        if (!self.dbMarketInfo) return callback("Database not available");

        self.dbMarketInfo.get(id, {valueEncoding: 'json'}, function (err, value) {
            if (err) {
                if (err.notFound) {return callback("id not found");}
                return callback(err);
            }
            return callback(null, value);
        });
    },

    getMarketsInfo: function(branch, callback){
        var self = this;        
        branch = branch || this.augur.constants.DEFAULT_BRANCH_ID;
        if (!self.marketsInfo) return callback("marketsInfo not loaded");
        if (!self.marketsInfo[branch]) return callback(null, "{}");

        return callback(null, JSON.stringify(self.marketsInfo[branch]));
    },

    filterProps: function (doc){
        var self = this;
        for (var prop in doc) {
            if (!self.marketProps[prop]){
                delete doc[prop];
            }
        }
    },

    upsertMarketInfo: function(id, market, callback){
        var self = this;
        callback = callback || noop;
        if (!id) return callback ("upsertMarketInfo: id not found");
        if (!self.db || !self.dbMarketInfo) return callback("upsertMarketInfo: db not found");
        if (!market.branchId) return callback("upsertMarketInfo: branchId not found in market data");

        var branch = market.branchId;
        self.dbMarketInfo.put(id, market, {valueEncoding: 'json'}, (err) => {
            //Only need to cache a subset of fields.
            //Make a copy of object so we don't modify doc that was passed in.
            var cacheInfo = JSON.parse(JSON.stringify(market));
            self.filterProps(cacheInfo);
            //trading generated, not stored on chain. We want to cache this.
            cacheInfo.tradingFee = self.augur.getTradingFee(id);
            if (err) return callback("upsertMarket error:", err);

            self.marketsInfo[branch] = self.marketsInfo[branch] || {};
            self.marketsInfo[branch][id] = cacheInfo;
            return callback(null);
        });
    },

    scan: function (config, callback) {
        var self = this;
        config = config || {};
        callback = callback || noop;
        var numMarkets = 0;
        //TODO: need to scan all branches?
        if (this.db && typeof this.db === "object" && 
            this.marketsInfo && typeof this.marketsInfo === "object") {

            config.limit = config.limit || Number.MAX_VALUE;
            var branches = self.augur.getBranches();
            async.each(branches, function (branch, nextBranch){
                if (numMarkets < config.limit) {
                    var markets = self.augur.getMarketsInBranch(branch);
                    console.log("Loading", markets.length, "markets from branch", branch);
                    var count = 0;
                    async.each(markets, function (market, nextMarket){
                        //only do this if we haven't hit out market limit yet set in config.
                        if (numMarkets < config.limit) {
                            if (++count%100==0){
                                console.log((count/markets.length*100).toFixed(2), "% complete");
                            }
                            var marketInfo = self.augur.getMarketInfo(market);
                            if (marketInfo && !marketInfo.error){
                                self.upsertMarketInfo(market, marketInfo)
                            }
                            numMarkets++;
                        }
                        nextMarket();
                    }, (err) => {
                        if (err) return nextBranch(err);
                        nextBranch();
                    });
                }else{
                    nextBranch(); //skips to next branch if market limit already hit.
                }
            }, (err) => {
                if (err) return callback(err);
                callback(null, numMarkets);
            });

        } else {
            this.connect(config, (err) => {
                if (err) return callback(err);
                self.scan(config, callback);
            });
        }
    },

    watch: function (config, callback) {
        var self = this;
        config = config || {};

        function marketCreated(filtrate) {
            if (!filtrate) return;

            for (var i = 0; i < filtrate.length; ++i){
                var doc = filtrate[i];
                if (!doc['data']) continue;
                self.augur.getMarketInfo(doc['data'], (marketInfo) => {
                    self.upsertMarketInfo(doc['data'], marketInfo);
                });
            }
        }

        function priceChanged(filtrate) {
            if (!filtrate) return;
            if (!filtrate['marketId']) return;
            self.augur.getMarketInfo(filtrate['marketId'], (marketInfo) => {
                self.upsertMarketInfo(filtrate['marketId'], marketInfo);
            });
        }

        function doneSyncing(){

            function pulseHelper(){
                if (!config.scan) {
                    if (callback) callback(null, 0);
                }else{
                    (function pulse() {
                        self.scan(config, (err, updates, markets) => {
                            if (callback) {
                                if (err) return callback(err);
                                callback(null, updates);
                            }
                        });
                        if (config.interval) {
                            self.watcher = setTimeout(pulse, config.interval || INTERVAL);
                        }
                    })();
                }
            }

            //if we are filtering, delay watch callback/scan pulsing until filters are set up
            if (config.filtering) {
                self.augur.filters.listen({
                    marketCreated: marketCreated,
                    price: priceChanged,
                }, function (filters) {
                   pulseHelper();
                });
            }else{
                pulseHelper();
            }
        }

        this.connect(config, (err) => {
            if (err) {
                if (callback) callback(err);
            } else {
                if (self.debug) console.log("Connected");
                //Wait until syncing completes to scan/setup filters.
                function syncWait() {
                    var syncing = self.augur.rpc.eth("syncing");
                    var peers = parseInt(self.augur.rpc.net("peerCount"));
                    if (!peers){
                        console.log("Waiting for peers");
                        setTimeout(syncWait, 30000);
                        return;
                    }
                    if (syncing == false){
                        console.log("done syncing");
                        doneSyncing();
                    }else{
                        console.log('Blockchain still syncing:', (parseInt(syncing['currentBlock'])/parseInt(syncing['highestBlock'])*100).toFixed(1) + "% complete");
                        setTimeout(syncWait, 30000);
                    }
                }
                syncWait();
            }
        });
    },

    unwatch: function () {
        var self = this;

        self.augur.filters.ignore(true);
    
        if (self.watcher) {
            clearTimeout(this.watcher);
            self.watcher = null;
        }

    }

};
