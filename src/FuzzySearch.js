/**
 * @license FuzzySearch.js
 * Autocomplete suggestion engine using approximate string matching
 * https://github.com/jeancroy/FuzzySearch
 *
 * Copyright (c) 2015, Jean Christophe Roy
 * Licensed under The MIT License.
 * http://opensource.org/licenses/MIT
 */

(function () {
    'use strict';

    /**
     * @param options
     * @constructor
     */

    function FuzzySearch(options) {

        if (options === undefined) options = {};
        if (!(this instanceof FuzzySearch)) return new FuzzySearch(options);
        FuzzySearch.setOptions(this, options, FuzzySearch.defaultOptions, true)

    }


    FuzzySearch.defaultOptions =
    /** @lends {FuzzySearch.prototype} */{

        //
        //  Scoring, include in result
        //

        minimum_match: 1.0,               // Minimum score to consider two token are not unrelated
        thresh_include: 2.0,              // To be a candidate, score of item must be at least this
        thresh_relative_to_best: 0.5,     // and be at least this fraction of the best score
        field_good_enough: 20,            // If a field have this score, stop searching other fields. (field score is before item related bonus)

        //
        //  Scoring, bonus
        //

        bonus_match_start: 0.5,          // Additional value per character in common prefix
        bonus_token_order: 2.0,          // Value of two token properly ordered
        bonus_position_decay: 0.7,       // Exponential decay for position bonus (smaller : more importance to first item)

        score_per_token: true,            // if true, split query&field in token, allow to match in different order
                                          // if false, bypass at least half the computation cost, very fast
                                          // also disable different token that score different field, because no more token!!

        score_test_fused: false,           // Try one extra match where we disregard token separation.
                                          // "oldman" match "old man"

        //
        //  Output sort & transform
        //

        score_round: 0.1,                // Two item that have the same rounded score are sorted alphabetically
        output_limit: 0,                 // Return up to N result, 0 to disable

        sorter: compareResults,          // Function used to sort. See signature of Array.sort(sorter)

        output_map: "root.item",         // Transform the output, can be a function or a path string.
                                         // output_map="root" return SearchResult object, needed to see the score
                                         // output_map="root.item" return original object.
                                         // output_map="root.item.somefield" output a field of original object.
                                         //
                                         // output_map=function(root){ return something(root.item) }
                                         // ^this get original object and apply something() on it.

        //
        //  Tokens options
        //

        token_query_min_length: 2,       // Avoid processing very small words, include greater or equal, in query
        token_field_min_length: 3,       // include greater or equal, in item field
        token_query_max_length: 64,      // Shorten large token to give more even performance.
        token_field_max_length: 64,      // Shorten large token to give more even performance.
        token_fused_max_length: 64,      // Shorten large token to give more even performance.

        //Do not attempt to match token too different in size: n/m = len(field_tok)/len(query_tok)
        token_min_rel_size: 0.6,         // Field token should contain query token. Reject field token that are too small.
        token_max_rel_size: 6,           // Large field token tend to match against everything. Ensure query is long enough to be specific.


        //
        //  Interactive - suggest as you type.
        //  Avoid doing search that will be discarded without being displayed
        //  This also help prevent lag/ temp freeze
        //

        interactive_debounce: 150,   // This is initial value. Will try to learn actual time cost. Set to 0 to disable.
        interactive_mult: 1.2,       // Overhead for variability and to allow other things to happens (like redraw, highlight ).
        interactive_burst: 3,        // Allow short burst, prevent flicker due to debounce suppression of a callback

        //
        // Data
        //

        source: [],
        keys: [],
        dirty: false, // set to true to request a new lazy index pass. (index recomputed only on next search)
        index: [],    // source is processed using keys, then stored here

        //
        // Last search
        //

        query:null,
        results: [],
        start_time: 0,
        search_time: 0

    };

    /**
     * Number of bit in a int.
     * DEBUG-tip: setting this to zero will force "long string" algorithm for everything!
     * @const
     */
    var INT_SIZE = 32;

    /**
     * Set property of object,
     * Restrict properties that can be set from a list of available defaults.
     *
     * @param {FuzzySearch} self
     * @param {Object} options
     * @param {Object} defaults
     * @param {boolean} reset
     *
     */
    FuzzySearch.setOptions = function (self, options, defaults, reset) {

        //Record original data, if changed rebuild cache.
        var oSource = self.source, oKeys = self.keys;
        var key;

        if (reset) {

            for (key in defaults) {
                if (defaults.hasOwnProperty(key)) {
                    self[key] = (options.hasOwnProperty(key) &&  options[key]!== undefined ) ? options[key] : defaults[key];
                }
            }

        } else {

            for (key in options) {
                if (options.hasOwnProperty(key) && defaults.hasOwnProperty(key) &&  options[key]!== undefined) {
                    self[key] = options[key];
                }
            }

        }

        if (self.source !== oSource || self.keys !== oKeys) {
            FuzzySearch.addSource(self, self.source, self.keys, true);
            self.dirty = false;
        }

    };

    /**
     * Add or replace data to search in.
     * Flatten object into array using specified keys,
     * Apply lowercase, accent removal
     * Split field into token
     * Remove small token eg "a" "of" and prefix large token
     *
     * @param {FuzzySearch} self
     * @param {Array.<Object>} source
     * @param {Array.<string>} keys
     * @param {boolean} overwrite
     * @return {FuzzySearch} self
     *
     */

    FuzzySearch.addSource = function (self, source, keys, overwrite) {

        var nb_items = source.length, out_index;

        if (overwrite) {
            self.index = new Array(nb_items);
            out_index = 0
        } else
            out_index = nb_items;

        var index = self.index;
        var min_size = self.token_field_min_length;
        var max_size = self.token_field_max_length;

        for (var item_index = -1; ++item_index < nb_items;) {

            var item = source[item_index];
            var item_fields = FuzzySearch.generateFields(item, keys);

            var nb_fields = item_fields.length;
            var fields = new Array(nb_fields);

            for (var field_index = -1; ++field_index < nb_fields;) {
                fields[field_index] = FuzzySearch.filterSize(FuzzySearch.normalize(item_fields[field_index]).split(" "), min_size, max_size);
            }

            index[out_index++] = new Indexed(item, fields);

        }

        return self;

    };


    //
    // Helper object constructors
    //

    /**
     * Hold a query, see _prepQuery for detail.
     *
     * @param {string} normalized
     * @param {Array.<PackInfo>} tokens_groups
     * @param {string} fused_str
     * @param {Object} fused_map
     * @param {boolean} single
     * @constructor
     */
    function Query(normalized, tokens_groups, fused_str, fused_map, single) {
        this.normalized = normalized;
        this.tokens_groups = tokens_groups;
        this.fused_str = fused_str;
        this.fused_score = 0;
        this.fused_map = fused_map;
        this.single = single
    }

    /**
     * Hold a group of token for parallel scoring
     *
     * @param {Array.<string>} group_tokens
     * @param {Object} group_map
     * @param {number} gate
     * @constructor
     */
    function PackInfo(group_tokens, group_map, gate) {
        this.tokens = group_tokens;
        this.map = group_map;
        this.gate = gate;

        var t = group_tokens.length, i = -1;
        var scores = new Array(t);
        while (++i < t) scores[i] = 0;

        this.score_item = scores.slice();
        this.score_field = scores.slice();
        this.field_pos = scores;
    }

    /**
     * Output of search when output_map=""
     *
     * @param {*} item
     * @param {Array} fields
     * @param {number} item_score
     * @param {number} matched_field_index
     * @param {string|number} sortkey
     * @constructor
     * @extends Indexed
     */
    function SearchResult(item, fields, item_score, matched_field_index, sortkey) {
        this.item = item;
        this.fields = fields;
        this.score = item_score;
        this.matchIndex = matched_field_index;
        this.sortKey = sortkey;
    }

    /**
     * Original item with cached normalised field
     *
     * @param {*} original
     * @param {Array.<string>} fields
     * @constructor
     */

    function Indexed(original, fields) {
        this.item = original;
        this.fields = fields;
    }

    /**
     * Comparator for array.sort(),
     * first by decreasing order of score, then alphabetical order of sortkey.
     *
     * @param {SearchResult} a
     * @param {SearchResult} b
     * @returns {number} -  ">0" if b before a, "<0" if b after a.
     */
     function compareResults (a, b) {
        var d = b.score - a.score;
        if (d !== 0) return d;
        var ak = a.sortKey, bk = b.sortKey;
        return ak > bk ? 1 : ( ak < bk ? -1 : 0);
    }


    FuzzySearch.prototype = {

        /**
         * Allow to change options after the object has been created.
         * If source is changed, new source is indexed.
         *
         * Optional reset allow to change any setting not in options to defaults.
         * This is similar to creating new object, but using same pointer.
         *
         * @param {Object=} options
         * @param {boolean=false} reset
         */
        setOptions: function (options, reset) {
            if (options === undefined) options = {};
            if (reset === undefined) reset = false;
            FuzzySearch.setOptions(this, options, FuzzySearch.defaultOptions, reset);
        },

        /**
         * Perform a search on the already indexed source.
         *
         * @param {string} querystring
         * @returns {Array}
         */
        search: function (querystring) {

            var clock = (window.performance && window.performance.now) ? window.performance : Date;
            var time_start = clock.now();
            this.start_time = time_start;

            if(this.dirty){
                FuzzySearch.addSource(this, this.source, this.keys, true);
                this.dirty = false;
            }

            var query = this.query = this._prepQuery(querystring);
            var source = this.index;
            var results = [];

            var thresh_include = this._searchIndex(query, source, results);

            //keep only results that are good enough compared to best
            results = FuzzySearch.filterGTE(results, "score", thresh_include);

            // sort by decreasing order of score
            // equal rounded score: alphabetical order
            if (typeof this.sorter == "function")
                results = results.sort(this.sorter);

            if (this.output_map || this.output_limit > 0) {
                if(typeof this.output_map == "function")
                    results = FuzzySearch.map(results, this.output_map, this, this.output_limit);
                else
                    results = FuzzySearch.mapField(results, this.output_map, this.output_limit);
            }

            var time_end = clock.now();
            this.search_time = time_end - time_start;
            this.results = results;

            return results

        },


        /**
         * Main search loop for a specified source
         * This separation allow to search a different source, or a subset of source
         *
         * @param {Query} query
         * @param {Array.<Indexed>} source
         * @param {Array.<SearchResult>} results
         * @returns {number} - thresh_include after this run.
         *
         * @private
         */

        _searchIndex: function (query, source, results) {

            var opt_bpd = this.bonus_position_decay;
            var opt_fge = this.field_good_enough;
            var opt_trb = this.thresh_relative_to_best;
            var opt_score_tok = this.score_per_token;
            var thresh_include = this.thresh_include;
            var best_item_score = 0;

            var single = query.single;

            for (var item_index = -1, nb_items = source.length; ++item_index < nb_items;) {

                //get indexed fields
                var item = source[item_index];
                var item_fields = item.fields;

                //
                //reset score
                //

                var groups = query.tokens_groups;

                for (var group_index = -1, nb_groups = groups.length; ++group_index < nb_groups;) {

                    var scitm = groups[group_index].score_item;
                    for(var i=-1, l = scitm.length;++i<l;) scitm[i]=0

                }

                query.fused_score = 0;

                var item_score = 0;
                var matched_field_index = -1;
                var position_bonus = 1.0;

                //
                //Foreach field
                //

                for (var field_index = -1, nb_fields = item_fields.length; ++field_index < nb_fields;) {

                    var field_score;

                    if (opt_score_tok){

                        if(single)
                            field_score = this._scoreFieldSingle(item_fields[field_index], query);
                        else
                            field_score = this._scoreField(item_fields[field_index], query);
                    }
                    else
                        field_score = FuzzySearch.score_map(query.fused_str, item_fields[field_index].join(" "), query.fused_map, this);

                    field_score *= (1.0 + position_bonus);
                    position_bonus *= opt_bpd;

                    if (field_score > item_score) {
                        item_score = field_score;
                        matched_field_index = field_index;

                        if (field_score > opt_fge) break;
                    }

                }

                //
                // Different query token match different fields ?
                //

                if (opt_score_tok && !single) {

                    var query_score = 0;
                    for (group_index = -1; ++group_index < nb_groups;) {
                        var group_scores = groups[group_index].score_item;
                        for (var j = -1, nb_scores = group_scores.length; ++j < nb_scores;) {
                            query_score += group_scores[j]
                        }
                    }

                    if (query.fused_score > query_score) query_score = query.fused_score;
                    item_score = 0.5 * item_score + 0.5 * query_score;

                }

                //
                // Keep track of best result, this control inclusion in the list
                //

                if (item_score > best_item_score) {
                    best_item_score = item_score;
                    var tmp = item_score * opt_trb;
                    if (tmp > thresh_include) thresh_include = tmp;
                }

                //
                //candidate for best result ? push to list
                //

                if (item_score > thresh_include) {

                    item_score = Math.round(item_score / this.score_round) * this.score_round;

                    results.push(new SearchResult(
                        item.item,
                        item_fields,
                        item_score,
                        matched_field_index,
                        item_fields[0].join(" ")
                    ));

                }

            }

            return thresh_include
        },

        /**
         * Internal loop that is run for each field in an item
         *
         * @param {Array} field_tokens - see FuzzySearch.getFields, FuzzySearch.addSource
         * @param {Query} query
         * @returns {number}
         * @private
         */

        _scoreField: function (field_tokens, query) {

            var groups = query.tokens_groups;
            var nb_groups = groups.length;
            var nb_tokens = field_tokens.length;
            var field_score = 0, sc;
            var last_index = -1;

            var bonus_order = this.bonus_token_order;
            var minimum_match = this.minimum_match;

            var token, scores, i;
            for (var group_index = -1; ++group_index < nb_groups;) {

                var group_info = groups[group_index];
                var group_tokens = group_info.tokens;
                var nb_scores = group_tokens.length;
                var single = (nb_scores == 1);

                //var best_match_this_field = group_info.reset.slice();
                //var best_match_index = group_info.reset.slice();

                var best_of_field = group_info.score_field;
                for(i=-1;++i<nb_scores;) best_of_field[i]=0

                var best_index = group_info.field_pos;
                for(i=-1;++i<nb_scores;) best_index[i]=0

                for (var field_tk_index = -1; ++field_tk_index < nb_tokens;) {

                    token = field_tokens[field_tk_index];

                    if (single) {

                        sc = FuzzySearch.score_map(group_tokens[0], token, group_info.map, this);
                        if (sc > best_of_field[0]) {
                            best_of_field[0] = sc;
                            best_index[0] = field_tk_index;
                        }

                    }
                    else {

                        scores = FuzzySearch.score_pack(group_info, token, this);
                        for (i = -1; ++i < nb_scores;) {
                            sc = scores[i];
                            if (sc > best_of_field[i]) {
                                best_of_field[i] = sc;
                                best_index[i] = field_tk_index;
                            }
                        }

                    }

                }

                var best_match_this_item = group_info.score_item;
                for (i = -1; ++i < nb_scores;) {

                    sc = best_of_field[i];
                    field_score += sc;

                    if (sc > best_match_this_item[i])
                        best_match_this_item[i] = sc;

                    // if search token are ordered inside subject give a bonus
                    // only consider non empty match for bonus
                    if (sc > minimum_match) {
                        var tmp = best_index[i];
                        if (tmp > last_index) field_score += bonus_order;
                        last_index = tmp;
                    }

                }


            }

            if (this.score_test_fused) {
                // test "space bar is broken" no token match
                var fused_score = FuzzySearch.score_map(query.fused_str, field_tokens.join(" "), query.fused_map, this);
                field_score = fused_score > field_score ? fused_score : field_score;

                if (fused_score > query.fused_score) {
                    query.fused_score = fused_score;
                }
            }


            return field_score;

        },

        /**
         * Fast pass for a single token query
         *
         * - Tokens is the same as fused, bypass packinfo
         * - No ordering bonus, nothing to order
         * - No "multiple words match multiple field", single word
         *
         * @param {Array} field_tokens - see FuzzySearch.getFields, FuzzySearch.addSource
         * @param {Query} query
         * @returns {number}
         * @private
         */

        _scoreFieldSingle: function (field_tokens, query) {

            var nb_tokens = field_tokens.length;
            var field_score = 0, sc;
            var query_str = query.fused_str;
            var query_map =  query.fused_map;

            for (var field_tk_index = -1; ++field_tk_index < nb_tokens;) {

                var token = field_tokens[field_tk_index];
                sc = FuzzySearch.score_map(query_str, token,query_map, this);

                if (sc > field_score) {
                    field_score = sc;
                }

            }

            if (this.score_test_fused) {

                // test "space bar is broken" no token match
                var fused_score = FuzzySearch.score_map(query_str, field_tokens.join(" "), query_map, this);
                field_score = fused_score > field_score ? fused_score : field_score;

                if (fused_score > query.fused_score) {
                    query.fused_score = fused_score;
                }

            }

            return field_score;

        },

        /**
         * Input: a user search string
         * Output a query object
         *
         * Perform a few transformation to allw faster searching.
         * String is set to lowercase, some accents removed, split into tokens.
         * Token too small are filtered out, token too large are trimmed.
         * Token are packed in group of 32 char, each token is processed to extract an alphabet map.
         *
         * If score_test_fused is enabled, we do an extra pass disregarding tokens.
         * IF score_per_token is disabled this is the only pass we do.
         *
         * @param querystring
         * @returns {Query}
         * @private
         */

        _prepQuery: function (querystring) {

            var norm_query = FuzzySearch.normalize(querystring);
            var tokens = (this.score_per_token)? FuzzySearch.filterSize(norm_query.split(" "), this.token_query_min_length, this.token_query_max_length):[];
            var single = (tokens.length < 2);
            var groups = (single)? [] : FuzzySearch.pack_tokens(tokens);
            var fused = norm_query.substring(0, (single) ? this.token_field_max_length : this.token_fused_max_length);
            var map = (this.score_test_fused || !this.score_per_token || single)?  FuzzySearch.alphabet(fused) : {};
            return new Query(norm_query, groups, fused, map, single)

        },


        /**
         * Return a Debounced version of FuzzySearch.search.
         * New function signature allow to specific callback for different phase of the debounce.
         * De-bounce is adaptative, it will allow short burst and try to learn actual computation time.
         *
         * query: term to search
         * immediate_cb(results) : if search was done without filtering
         * suppress_cb(cached_results) : debounce has supressed the search, return cache of last result
         * finally_cb(results): if at least 1 supression occured, make a new search when debounce end and call this.
         *
         * @returns {Function}
         */
        getInteractive: function () {

            var self = this;
            var wait = this.interactive_debounce;
            var mult = this.interactive_mult;
            var burst = this.interactive_burst;

            // Debounce off
            if (wait === 0) {
                return (function (query, immediate_cb) {
                    return immediate_cb(self.search(query))
                })
            }

            // Debounce
            var clock = (window.performance && window.performance.now) ? window.performance : Date;
            var timeout, cache;
            var count = 0, suppressed = false;

            return function (query, immediate_cb, suppress_cb, finally_cb) {

                var later = function () {
                    timeout = null;
                    if (suppressed) {
                        cache = self.search(query);
                        finally_cb(cache);
                    }
                    count = 0;
                    suppressed = false;
                };

                clearTimeout(timeout);
                timeout = setTimeout(later, wait);

                if (++count < burst) {

                    suppressed = false;
                    var before = clock.now();
                    cache = self.search(query);
                    var ret = immediate_cb(cache);
                    var now = clock.now();

                    //try to learn  typical time (time mult factor);
                    wait = 0.5 * wait + 0.5 * mult * (now - before);
                    //console.log(wait);
                    return ret;

                } else {
                    suppressed = true;
                    //console.log("supress");
                    return suppress_cb(cache);
                }
            }

        },

        /**
         * Allow the FuzzySearch object to be given as a source to twitter typeahead.
         * This implement similar interface than Bloodhound object.
         *
         * @returns {Function} Interactive version of search.
         */

        __ttAdapter: function ttAdapter() {

            var debounced = this.getInteractive();
            var noop = function (a) {
            };
            return function (query, sync, async) {
                debounced(query, sync, noop, async);
            }

        },

        /**
         * Generate a function compatible with jQuery UI auto-complete Source
         *
         * @returns {Function} Interactive version of search.
         */
        $uiSource: function(){

            var debounced = this.getInteractive();
            var noop = function (a) {
            };
            return function (request, response) {
                debounced(request.term, response, noop, response);
            }

        },

        /**
         * Given a SearchResult object, recover the value of the best matching field.
         * This is done on demand for display.
         *
         * @param {SearchResult} result
         * @return {string} original field
         */

        getMatchingField : function(result){
            var f = FuzzySearch.generateFields(result.item, this.keys);
            return f[result.matchIndex]
        }

    };


    // replace most common accents in french-spanish by their base letter
    //"ãàáäâæẽèéëêìíïîõòóöôœùúüûñç"
    var from = "\xE3\xE0\xE1\xE4\xE2\xE6\u1EBD\xE8\xE9\xEB\xEA\xEC\xED\xEF\xEE\xF5\xF2\xF3\xF6\xF4\u0153\xF9\xFA\xFC\xFB\xF1\xE7";
    var to = "aaaaaaeeeeeiiiioooooouuuunc";
    var diacriticsMap = {};
    for (var i = 0; i < from.length; i++) {
        diacriticsMap[from[i]] = to[i]
    }

    /**
     * Take a string into a normal form. Allow to compare in a case insensitive way.
     * Also allow to match accents with their base form "é" vs "e"
     * Finally standardize token separator to be a single space.
     *
     * @param {string} str
     * @returns {string} - normalised str
     */
    FuzzySearch.normalize = function (str) {
        if (!str)return "";
        return str.toLowerCase().replace(/\s+/g, " ").replace(/[^\u0000-\u007E]/g, function (a) {
            return diacriticsMap[a] || a;
        });
    };


    /**
     * Given an object to index and a list of field to index
     * Return a flat list of the values.
     *
     * @param {Object} obj
     * @param {Array.<string>} fieldlist
     * @returns {Array}
     */

    FuzzySearch.generateFields = function (obj, fieldlist) {

        if (!fieldlist.length) return [obj.toString()];

        var indexed_fields = [];
        for (var i = 0; i < fieldlist.length; i++) {
            _collectValues(obj, fieldlist[i].split("."), indexed_fields, 0)
        }
        return indexed_fields;

    };



    /**
     * Traverse an object structure to collect item specified by parts.
     * If leaf node is an array or dictionary collect every children.
     * If key is wildcard '*' branch out the search process on each children.
     *
     * @param {Object|Array} obj - root to process
     * @param {Array.<string>} parts - array of subkey to direct object traversal  "those.that.this"->["those","that","this"]
     * @param {Array} list - where to put collected items
     * @param {number} level - index of current position on parts list
     * @returns {Array} - return list
     * @private
     */
    function _collectValues(obj, parts, list, level) {

        var key, i, olen;
        var nb_level = parts.length;
        while (level < nb_level) {

            key = parts[level];
            if (key === "*" || key === "") break;
            if (!(key in obj)) return list;
            obj = obj[key];
            level++

        }

        var type = Object.prototype.toString.call(obj);
        var isArray = ( type === '[object Array]'  );
        var isObject = ( type === '[object Object]' );


        if (level === nb_level) {

            if (isArray) {
                olen = obj.length;
                for (i = -1; ++i < olen;) {
                    list.push(obj[i].toString())
                }
            }

            else if (isObject) {
                for (key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        list.push(obj[key].toString())
                    }
                }
            }

            else list.push(obj.toString());

        }

        else if (key === "*") {

            level++;
            if (isArray) {
                olen = obj.length;
                for (i = -1; ++i < olen;) {
                    _collectValues(obj[i], parts, list, level);
                }
            }
            else if (isObject) {
                for (key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        _collectValues(obj[key], parts, list, level);
                    }
                }
            }

        }

        return list;
    }

    /**
     * Process an array of string, filter out item smaller than min, trim item larger than max.
     *
     * @param {Array.<string>} array - array of string
     * @param minSize - filter out item smaller than this
     * @param maxSize - substring item larger than this
     * @returns {Array}
     */

    FuzzySearch.filterSize = function (array, minSize, maxSize) {
        var i = -1, j = -1;
        var n = array.length;
        var out = [];
        var str, slen;

        while (++i < n) {
            str = array[i];
            slen = str.length;
            if (slen >= minSize) {
                if (slen < maxSize)
                    out[++j] = str;
                else
                    out[++j] = str.substr(0, maxSize)
            }
        }
        return out;
    };


    /**
     * Like Array.prototype.map()
     *
     * @param {Array} source
     * @param {function(*, number , Array)|null} transform callback
     * @param {*=} context thisarg
     * @param {number=} max_out
     * @returns {Array}
     */

    FuzzySearch.map = function (source, transform, context, max_out) {

        var n = source.length;
        if (max_out > 0 && max_out < n) n = max_out;
        if (typeof transform !== "function") return source.slice(0, n);

        var out = new Array(n);
        for (var i = -1;++i < n;) {
            out[i] = transform.call(context, source[i], i, source);
        }

        return out;

    };


    /**
     * Take an array of objects, return an array containing a field of those object.
     *
     * test = [ {key:"A",value:10}, {key:"B",value:20}  ]
     * mapField(test,"value") = [10,20]
     *
     * @param source - array to process
     * @param {string} path - key to address on each item OR function to apply
     * @param {Number=} [max_out=source.length] - only process first items
     * @returns {Array}
     */

    FuzzySearch.mapField = function (source, path, max_out) {

        var n = source.length;
        if (max_out > 0 && max_out < n) n = max_out;
        if (path === "" || path === "root") return source.slice(0, n);

        var out = new Array(n);
        var obj, i;

        if(path.substr(0,5)==="root.") path = path.substr(5);

        if (path.indexOf(".") === -1) {
            //fast case no inner loop
            for (i = -1; ++i < n;) {
                obj = source[i];
                if (path in obj) out[i] = obj[path];
            }

        } else {

            //general case
            var parts = path.split(".");
            var nb_level = parts.length;

            for (i = -1; ++i < n;) {
                obj = source[i];

                for (var level = -1; ++level < nb_level;) {
                    var key = parts[level];
                    if (!(key in obj)) break;
                    obj = obj[key];
                }

                out[i] = obj;
            }

        }

        return out;

    };

    FuzzySearch.filterGTE = function (array, field, compareto) {
        var i = -1, j = -1;
        var n = array.length;
        var out = [], obj;

        while (++i < n) {
            obj = array[i];
            if (obj[field] >= compareto) {
                out[++j] = obj;
            }
        }

        return out;
    };


    //-----------------------------
    //       SCORING FUNCTIONS
    // ---------------------------


    // Adapted from paper:
    // A fast and practical bit-vector algorithm for
    // the Longest Common Subsequence problem
    // Maxime Crochemore et Al.
    //
    // With modification from
    // Bit-parallel LCS-length computation revisited (H Hyyrö, 2004)
    // http://www.sis.uta.fi/~hh56766/pubs/awoca04.pdf
    //

    /**
     * Score of "search a in b" using self as options.
     * @param  {string} a
     * @param {string} b
     */
    FuzzySearch.prototype.score = function (a, b) {
        var aMap = FuzzySearch.alphabet(a);
        return FuzzySearch.score_map(a, b, aMap, this);
    };

    /**
     * Score of "search a in b" using precomputed alphabet map
     * Main algorithm for single query token to score
     *
     * @param {string} a
     * @param {string} b
     * @param {Object} aMap - See FuzzySearch.alphabet
     * @param {FuzzySearch} options
     */
    FuzzySearch.score_map = function (a, b, aMap, options) {

        var j, lcs_len;
        var m = a.length;
        var n = b.length;
        var bonus_prefix = options.bonus_match_start;

        var k = m < n ? m : n;
        if (k === 0 || n < options.token_min_rel_size * m || n > options.token_max_rel_size * m) return 0;

        //normalize score against length of both inputs
        var sz_score = (m + n) / ( 2.0 * m * n);

        //common prefix is part of lcs
        var prefix = 0;
        if (a === b) prefix = k; //speedup equality
        else {
            while ((a[prefix] === b[prefix]) && (++prefix < k)) {
            }
        }

        //shortest string consumed
        if (prefix === k) {
            lcs_len = prefix;
            return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;
        }

        //alternative algorithm for large string
        //need to keep this condition in sync with bitvector
        if (m > INT_SIZE) {
            lcs_len = FuzzySearch.llcs_large(a, b, aMap, prefix);
            return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;
        }

        var mask = ( 1 << m ) - 1;
        var S = mask, U, c;

        j = prefix - 1;
        while (++j < n) {
            c = b[j];
            if (c in aMap) {
                // Hyyrö, 2004 S=V'=~V
                U = S & aMap[c];
                S = (S + U) | (S - U);
            }
        }

        // Remove match already accounted in prefix region.
        mask &= ~( ( 1 << prefix ) - 1 );

        // lcs_len is number of 0 in S (at position lower than m)
        // inverse S, mask it, then do "popcount" operation on 32bit
        S = ~S & mask;

        S = S - ((S >> 1) & 0x55555555);
        S = (S & 0x33333333) + ((S >> 2) & 0x33333333);
        lcs_len = (((S + (S >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;

        lcs_len += prefix;
        return sz_score * lcs_len * lcs_len + bonus_prefix * prefix;

    };

    /**
     * Score multiple query token against a single field token.
     * Apply above score function in parallel
     * Computation is done as if everything was one big token,
     * but ZM bit-vector modify boundary so score are independant
     *
     * @param {PackInfo} packinfo
     * @param {string} field_token
     * @param {FuzzySearch} options
     * @returns {Array.<number>} scores
     */
    FuzzySearch.score_pack = function (packinfo, field_token, options) {

        var packed_tokens = packinfo.tokens;
        var nb_packed = packed_tokens.length;

        var S = 0xFFFFFFFF, U, c;
        var ZM = packinfo.gate | 0;
        var aMap = packinfo.map;

        var n = field_token.length, j = -1;

        while (++j < n) {
            c = field_token[j];
            if (c in aMap) {
                U = S & aMap[c];
                S = ( (S & ZM) + (U & ZM) ) | (S - U);
            }
        }

        S = ~S;

        var k = -1;
        var offset = 0;
        var bonus_prefix = options.bonus_match_start;
        var min_rs = options.token_min_rel_size;
        var max_rs = options.token_max_rel_size;
        var scores = new Array(nb_packed);

        while (++k < nb_packed) {

            var query_tok = packed_tokens[k];
            var m = query_tok.length;
            var lcs_len, prefix;

            if (n < min_rs * m || n > max_rs * m) {
                scores[k] = 0;
                offset += m;
                continue;
            }

            if (query_tok === field_token)
                prefix = lcs_len = m;

            else {
                var p = (m < n) ? m : n;
                prefix = 0;
                while ((query_tok[prefix] === field_token[prefix]) && (++prefix < p)) {
                }
                lcs_len = prefix;
                var Sm = ( (S >>> offset) & ( (1 << m) - 1 ) ) >>> prefix;
                while (Sm) {
                    Sm &= Sm - 1;
                    lcs_len++
                }
            }

            offset += m;
            var sz = (m + n) / ( 2.0 * m * n);
            scores[k] = sz * lcs_len * lcs_len + bonus_prefix * prefix;

        }

        return scores;

    };

    // - - - - - - - - - - - - - - - - -
    //  SECTION
    //  Prepare query for search
    // - - - - - - - - - - - - - - - - -


    /**
     * Given a list of tokens, pack them into group of upto INT_SIZE(32) chars.
     * If a single token is bigger than INT_SIZE create a groupe of a single item
     * And use posVector instead of bitVector to prepare fallback algorithm.
     *
     * @param {Array.<string>} tokens
     * @returns {Array.<PackInfo>}
     */
    FuzzySearch.pack_tokens = function (tokens) {

        var token_index = -1;
        var nb_tokens = tokens.length;
        var large;
        var groups = [];

        //For each group
        while (token_index < nb_tokens) {

            var group_tokens = [];
            var group_map = {};
            var offset = 0;
            var gate = 0;

            //For each token in the group
            while (++token_index < nb_tokens) {

                var token = tokens[token_index];
                var l = token.length;

                if (l >= INT_SIZE) {

                    large = new PackInfo([token],
                        FuzzySearch.posVector(token),
                        0xFFFFFFFF);

                    break;

                }
                else if (l + offset >= INT_SIZE) {
                    token_index--;
                    break;
                }
                else {
                    group_tokens.push(token);
                    FuzzySearch.bitVector(token, group_map, offset);
                    gate |= ( (1 << ( token.length - 1) ) - 1 ) << offset;
                    offset += l
                }

            }

            if (group_tokens.length > 0) {
                groups.push(new PackInfo(group_tokens, group_map, gate));
            }

            if (large) {
                groups.push(large);
                large = null;
            }

        }

        return groups;

    };

    /**
     * Record position of each character in a token.
     * If token is small, position is recorded by position of a single bit in an int.
     * If token is larger than INT_SIZE, position is recorder as array of number.
     *
     * @param {string} token
     * @returns {Object} key value map char->positions (as array of position or single int (can be seen as an array of bit) )
     */
    FuzzySearch.alphabet = function (token) {
        var len = token.length;
        if (len > INT_SIZE) return FuzzySearch.posVector(token);
        else return FuzzySearch.bitVector(token, {}, 0);
    };

    /**
     * Apply FuzzySearch.alphabet on multiple tokens
     *
     * @param {Array.<string>} tokens
     * @returns {Array.<Object>}
     */
    FuzzySearch.mapAlphabet = function (tokens) {
        var outlen = tokens.length;
        var out = new Array(outlen), i = -1;
        while (++i < outlen) {
            var t = tokens[i];
            if (t.length > INT_SIZE) out[i] = FuzzySearch.posVector(t);
            else out[i] = FuzzySearch.bitVector(t, {}, 0);
        }
        return out;
    };

    /**
     * Record position of each char using a single bit
     *
     * @param {string} token
     * @param {Object} map - Existing map to modify, can init with {}
     * @param offset - used for packing multiple word in a single map, can init with 0
     * @returns {Object} Key value map char -> int
     */

    FuzzySearch.bitVector = function (token, map, offset) {

        var len = token.length;
        var i = -1, c;
        var b = offset;

        while (++i < len) {
            c = token[i];
            if (c in map) map[c] |= (1 << b++);
            else map[c] = (1 << b++);
        }

        return map;

    };

    /**
     * Record position of each char in a token using an array
     * Append Infinity as a stop marker for llcs_large
     *
     * map = posVector("position")
     * map["p"] -> [0,Inf]
     * map["o"] -> [1,6,Inf]
     *
     * @param {string} pattern
     * @returns {Object} - key value map char->array of position (as number)
     */
    FuzzySearch.posVector = function (pattern) {

        var map = {}, c;

        var m = pattern.length, i = -1;
        while (++i < m) {
            c = pattern[i];
            if (c in map) map[c].push(i);
            else map[c] = [i];
        }

        for (c in map) {
            if (map.hasOwnProperty(c)) {
                map[c].push(Infinity);
            }
        }

        return map;

    };

    /**
     * A block with start and end position
     * Used to record consecutive increase position in llcs_large
     * @param start
     * @param end
     * @constructor
     */
    function Block(start, end) {
        this.start = start;
        this.end = end;
    }

    //
    // Compute LLCS, using vector of position.
    //
    // Based on:
    // An input sensitive online algorithm for LCS computation
    // Heikki Hyyro 2009
    //
    // We fill the dynamic programing table line per line
    // but instead of storing the whole line we only store position where the line increase
    // ( bitvector algorythm store increase yes/no as a bit) this time we will store sequence
    //
    //    s u r g e r y
    // g [0,0,0,1,1,1,1] : [3,4] (Add level 1)
    // s [1,1,1,1,1,1,1] : [0,1] (Make level 1 happens sooner)
    // u [1,2,2,2,2,2,2] : [0,2] (Add level 2, append to block of consecutive increase)
    // r [1,2,3,3,3,3,3] : [0,3] (Add level 3, append to block of consecutive increase)
    // v [1,2,3,3,3,3,3] : [0,3] (v not in surgery, copy)
    // e [1,2,3,3,4,4,4] : [0,3],[4,5] (Add level 4, create new block for it)
    // y [1,2,3,3,4,4,5] : [0,3],[4,5],[6,7] (Add level 5, create new block for it)
    //
    // There is 2 Basic operations:
    // - Make a level-up happens sooner
    // - Add an extra level up at the end. (this is where llcs increase !)
    //
    //  12345678901234567890  // Position (for this demo we start at 1)
    //  ii------iii---i--i--  // Increase point of previous line
    //  12222222345555666777  // Score previous line [1,3] [9,12] [15,16] [18,19]
    //  ---m-m---------m---m  // Match of this line
    //  12233333345555677778  // Score of this line [1,3] [4,5] [10,12] [15,17] [20,21]
    //  ii-i-----ii---ii---i  // New increase point
    //  12345678901234567890  // Position


    FuzzySearch.llcs_large = function (a, b, aMap, prefix) {

        //var aMap = FuzzySearch.posVector(a);

        //Position of next interest point. Interest point are either
        // - Increase in previous line
        // - Match on this line
        var block_start, match_pos;

        // We encode increase sequence as [start_pos, end_pos+1]
        // So end-start = length

        // To avoid dealing with to many edge case we place
        // a special token at start & end of list
        var last_line, current_line, line_index, last_end, block_end;
        if (prefix === undefined) prefix = 0;

        if (prefix)
            last_line = [new Block(0, prefix), new Block(Infinity, Infinity)];
        else
            last_line = [new Block(Infinity, Infinity)];

        var lcs_len = prefix;

        var match_list, match_index;
        var block, block_index, block_size;

        var n = b.length, j;
        for (j = prefix; j < n; j++) {

            //Each line we process a single character of b
            var c = b[j];
            if (!(c in aMap)) continue;
            match_list = aMap[c];

            //New line
            current_line = [];
            line_index = -1;

            //First match
            match_index = 0;
            match_pos = match_list[0];

            //Place first block before the string
            block_end = -1;
            block_index = -1;

            var nblock = last_line.length;
            while (++block_index < nblock) {

                //Place cursor just after last block
                last_end = block_end;

                //Read end block
                block = last_line[block_index];
                block_start = block.start; //Encode block as [s,e[
                block_end = block.end; //End is position of char that follow last.
                block_size = block_end - block_start;

                //get next match from list of matches
                while (match_pos < last_end) {
                    match_pos = match_list[++match_index];
                }

                // This cover two case
                // a) no match between two block
                // b) block happens after last match (so match_pos=Infinity).
                //    At the last block, this will append closing "sentinel" to line
                if (block_start <= match_pos) {
                    current_line[++line_index] = block;
                    continue;
                }

                //
                // If we have reached here, we have a dominant match !
                // Decide where to register the match ...
                //

                if (match_pos === last_end) {
                    //End of last block ? (step a.ii)
                    current_line[line_index].end++;
                }
                else {

                    //Increase need it's own block ( step a.i)
                    //try to reuse block that will get deleted.
                    if (block_size === 1) {
                        //Can we reuse next block ?
                        block.start = match_pos;
                        block.end = match_pos + 1;
                        current_line[++line_index] = block;
                    } else {
                        //start a new block
                        current_line[++line_index] = new Block(match_pos, match_pos + 1);
                    }

                }

                // if not empty, append next block to current line (step a.iii)
                // (this condition reject "sentinel", it'll get added just after the for loop)
                if (block_size > 1) {
                    block.start++; // Move start by one
                    current_line[++line_index] = block;
                }

            }

            // If the line finish with a match:
            //  a) llcs at end of this line is one greater than last line, increase score
            //  b) we still need to append sentinel
            if (block_start > match_pos) {
                current_line[++line_index] = block;
                lcs_len++
            }

            //last_line.length = 0;
            last_line = current_line;

            //console.log(JSON.stringify(last_line));
            //console.log(lcs_len)

        }

        return lcs_len;

    };


    //
    // Export FuzzySearch
    //

    if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {

        // CommonJS-like environments
        module.exports = FuzzySearch;

    } else if (typeof define === 'function' && define.amd) {

        // AMD. Register as an anonymous module.
        define(function () {
            return FuzzySearch;
        });

    } else {

        // Browser globals
        window['FuzzySearch'] = FuzzySearch;

    }

    return FuzzySearch;

})();

//
// Reference implementation to debug
// Might need to swap input to match internal of a given algorithm
//

/*
 function lcs(a, b) {

 var m = a.length;
 var n = b.length;
 var i, j;

 //init m by n array  with 0
 var C = [], row = [], lcs = [];
 for (j = 0; j < n; j++) row[j] = 0;
 for (i = 0; i < m; i++) C[i] = row.slice();

 //fill first row and col
 C[0][0] = (a[0] === b[0]) ? 1 : 0;
 for (i = 1; i < m; i++) C[i][0] = (a[i] === b[0] || C[i - 1][0]) ? 1 : 0
 for (j = 1; j < n; j++) C[0][j] = (a[0] === b[j] || C[0][j - 1]) ? 1 : 0
 console.log(JSON.stringify(C[0]));

 //bulk
 for (i = 1; i < m; i++) {
 for (j = 1; j < n; j++) {
 C[i][j] = (a[i] === b[j]) ? C[i - 1][j - 1] + 1 : Math.max(C[i][j - 1], C[i - 1][j]);
 }
 console.log(JSON.stringify(C[i]));
 }

 //backtrack
 i--;
 j--;
 while (i > -1 && j > -1) {
 if (i && C[i][j] == C[i - 1][j])  i--;
 else if (j && C[i][j] == C[i][j - 1]) j--;
 else {
 lcs.push(a[i]);
 j--;
 i--;
 }
 }

 return lcs.reverse().join('');
 }*/