/**
 * FuzzySearch.js
 * Autocomplete suggestion engine using approximate string matching
 * https://github.com/jeancroy/FuzzySearch
 *
 * @license:
 * Copyright (c) 2015, Jean Christophe Roy
 * Licensed under The MIT License.
 * http://opensource.org/licenses/MIT
 */


//
// Search a query across multiple item
//
// Each item has one or multiple fields.
// Query is split into tokens (words)
// Field are split into tokens.
//
// Query can match using free word order
// "paint my wall" -> "wall painting"
// (bonus is given for proper word order)
//
// Query can match across diferent field
// "Davinci Brown" -> item.title = "davinci code", item.author="dawn brown"
// (score is better for match in the same field)
//
// Score take field position into account.
// For example one can give preference to title over author
// Author over keyword1, keyword1 over keyword 2 and so on.
// (Position bonus fade exponentially so bonus between 1 and 2
// is far greater than bonus between 21 and 22)
//


var FuzzySearch = (function () {
    'use strict';

    var _defaults = {

        minimum_match: 1.0,               // Minimum score to consider two token are not unrelated
        thresh_include: 2.0,              // To be a candidate, score of item must be at least this
        thresh_relative_to_best: 0.5,     // and be at least this fraction of the best score
        field_good_enough: 20,            // If a field have this score, stop searching other fields. (field score is before item related bonus)

        bonus_match_start: 0.5,          // Additional value per character in common prefix
        bonus_token_order: 2.0,          // Value of two token properly ordered
        bonus_position_decay: 0.7,       // Exponential decay for position bonus (smaller : more importance to first item)

        score_round: 0.1,                // Two item that have the same rounded score are sorted alphabetically
        output_match_detail: true,       // if false output original item, if true output {score:...,item:...,match:..., matchIndex:...}
        cache_fields: true,

        max_search_tokens: 10,           // Because of free word order, each search token add cost equivalent to one traversal
                                         // additional tokens are lumped as a nth+1 token

        max_candidates:100,              // Stop search after that many good candidate found
                                         // Will trigger a recount to enforce relative_to_best rule


        highlight_prefix: false,         // true: force prefix as part of highlight, (false: minimum gap, slower)
        highlight_bridge_gap: 2,         // display small gap as substitution, set to size of gap, 0 to disable
        highlight_tk_max_size: 64,       // max size of a token for highlight algorithm (it is BVMAXSIZE(31) for search)

        //tag to put before/after the highlight
        highlight_before: '<strong class="highlight">',
        highlight_after:  '</strong>'


    };

    // Javascript use int of 32 bit,
    // we need one extra buffer to prevent overflow.
    var BVMAXSIZE = 31;

    function FuzzySearch(options) {

        var key;

        //Config:
        // copy key of options that are also in default
        // also add keys of default
        for (key in _defaults) {
            if (_defaults.hasOwnProperty(key)) {
                this[key] = (key in options)? options[key] : _defaults[key];
            }
        }


        this.source = options.source;
        this.fields = options.keys;
        this.search_time = 0;

    }

    FuzzySearch.defaultOptions = _defaults;


    //Helper on array
    function _map(array, transform) {
        var i = -1;
        var n = array.length;
        var out = new Array(n);

        while (++i < n) {
            out[i] = transform(array[i], i, array);
        }
        return out;
    }

    function _filterField(array, field, minval) {
        var i = -1,j = -1;
        var n = array.length;
        var out = [];

        while (++i < n) {
            var obj = array[i];
            if (obj[field] >= minval) {
                out[++j] = obj;
            }
        }
        return out;
    }


    FuzzySearch.prototype = {

        search: function (querystring) {

            var time_start = performance.now();

            var query = this._prepQuery(querystring);
            var score_init = query.tokens_score;

            var thresh_include = this.thresh_include;
            var best_item_score = 0;
            var results = [];

            var need_bestscore_cleanup = false;

            for (var source_index = 0; source_index < this.source.length; source_index++) {

                var item_score = 0;
                var matched_field_index = -1;
                var position_bonus = 1.0;

                //reset best kw score
                query.tokens_score = score_init.slice();
                query.fused_score = 0;

                //get indexed fields
                var item = this.source[source_index];
                var item_fields = this._getFields(item);

                for (var field_index = 0; field_index < item_fields.length; field_index++) {

                    var field_score = this._scoreField(item_fields[field_index], query);
                    field_score *= (1.0 + position_bonus);
                    position_bonus *= this.bonus_position_decay;

                    if (field_score > item_score) {
                        item_score = field_score;
                        matched_field_index = field_index;

                        if(field_score>this.field_good_enough) break;
                    }

                }

                // Mix best field score (all keyword in one field)
                // with best keyword score (all keyword any field)
                var query_score = 0;
                var score_per_token = query.tokens_score;
                for (var i = 0; i < score_per_token.length; i++) {
                    query_score += score_per_token[i]
                }

                //individual tokens or fused togheter ?
                query_score = query.fused_score > query_score ? query.fused_score : query_score;
                item_score = 0.5 * item_score + 0.5 * query_score;


                // get stat of the best result so far
                // this control inclusion of result in final list
                if (item_score > best_item_score) {

                    best_item_score = item_score;
                    var tmp = item_score * this.thresh_relative_to_best;
                    if (tmp > thresh_include) thresh_include = tmp;
                    need_bestscore_cleanup = true;

                }

                //candidate for best result ? push to list
                if (item_score > thresh_include) {
                    results.push(this._prepResult(item, item_score, matched_field_index));
                }

                //Should we stop searching ?
                if(results.length >= this.max_candidates){

                    //all candidate valid and max reached, stop search
                    if(!need_bestscore_cleanup) break;
                    else{
                        results = _filterField(results,"score",thresh_include);
                        need_bestscore_cleanup = false;
                    }

                }


            }


            //keep only results that are good enough compared to best
            if(need_bestscore_cleanup)
                results = _filterField(results,"score",thresh_include);

            // sort by decreasing order of score
            // equal rounded score: alphabetical order
            results = results.sort(function (a, b) {
                var d = b.score - a.score;
                return d == 0 ? a.alphaSortKey.localeCompare(b.alphaSortKey) : d;
            });

            if (!this.output_match_detail) {
                results = _map(results, function (a) {
                    return a.item
                });
            }

            var time_end = performance.now();
            //console.log("Search took " + (time_end-time_start) + " milliseconds.");
            this.search_time = time_end-time_start;

            return results


        },

        _scoreField: function (field, query) {

            var query_tokens = query.tokens;
            var query_bitvectors = query.bitvectors;
            var best_score_any_field = query.tokens_score;
            var bonus_match_start = this.bonus_match_start;

            var field_score = 0;
            var field_tokens = field.split(" ");

            // we allow free word ordering
            // but give bonus for proper token order
            var last_match_pos = -1;

            for (var query_index = 0; query_index < query_tokens.length; query_index++) {

                var query_tk = query_tokens[query_index];
                if (!query_tk.length) continue;

                var query_tk_bv = query_bitvectors[query_index];
                var best_score_this_field = 0;

                //for token order bonus
                var current_match_pos = -1;

                //for each search token, find the best matching item token
                for (var tok_index = 0; tok_index < field_tokens.length; tok_index++) {

                    var item_tk = field_tokens[tok_index];
                    if (!item_tk.length) continue;

                    var test_score = FuzzySearch.score_map(query_tk, item_tk, query_tk_bv,bonus_match_start);

                    //each query token is matched against it's best field token
                    if (test_score > best_score_this_field) {
                        best_score_this_field = test_score;
                        current_match_pos = tok_index;
                    }

                }

                //each search token keep a best overall match accross all item field
                if (best_score_this_field > best_score_any_field[query_index]) {
                    best_score_any_field[query_index] = best_score_this_field;
                }

                // if search token are ordered inside subject give a bonus
                // only consider non empty match for bonus
                if (best_score_this_field > this.minimum_match) {
                    if (current_match_pos > last_match_pos)  best_score_this_field += this.bonus_token_order;
                    last_match_pos = current_match_pos;
                }

                //item score is the sum of each search token score
                field_score += best_score_this_field;

            }

            // test "spacebar is broken" no token match
            var fused_score = FuzzySearch.score(query.normalized, field, this);
            field_score = fused_score > field_score ? fused_score : field_score;

            if (fused_score > query.fused_score) {
                query.fused_score = fused_score;
            }

            return field_score;

        },

        _getFields: function (item) {

            var item_fields;

            if (this.cache_fields && item._fields_) {
                item_fields = item._fields_;
            }
            else {
                item_fields = FuzzySearch.generateFields(item, this.fields);
                item_fields = _map(item_fields,FuzzySearch.normalize);
                if (this.cache_fields) item._fields_ = item_fields;
            }

            return item_fields;
        },

        _prepQuery: function (querystring) {

            var normquery = FuzzySearch.normalize(querystring);
            var query_tokens = normquery.split(" ");

            // lump tokens after max_search_tokens
            // if only one extra, it's already lumped
            var maxtksz = this.max_search_tokens;
            if (query_tokens.length > maxtksz + 1) {
                var extra = query_tokens.splice(maxtksz).join(" ");
                query_tokens.push(extra);
            }

            //reset best score
            var score_per_token = [];
            for (var i = 0; i < query_tokens.length; i++) {
                score_per_token[i] = 0
            }

            return {
                normalized: normquery,
                tokens: query_tokens,
                bitvectors: _map(query_tokens,FuzzySearch.bitVector),
                tokens_score: score_per_token,
                fused_score: 0
            };

        },

        _prepResult: function (item, item_score, matched_field_index) {

            var matched, sk;

            if (this.output_match_detail) {

                var f = FuzzySearch.generateFields(item, this.fields);
                matched = f[matched_field_index] || "";
                sk = f[0] || "";

            } else {

                matched = "";
                sk = FuzzySearch.getField(item, this.fields[0]);

            }

            item_score = Math.round(item_score / this.score_round) * this.score_round;

            return {
                score: item_score,
                item: item,
                "matchIndex": matched_field_index,
                "match": matched,
                "alphaSortKey": sk
            }


        },

        __ttAdapter: function ttAdapter() {

            var self = this;
            return function (query, sync_callback) {
                return sync_callback(self.search(query));
            };

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

    FuzzySearch.normalize = function (str) {
        return str.toLowerCase().replace(/\s+/g, " ").replace(/[^\u0000-\u007E]/g, function (a) {
            return diacriticsMap[a] || a;
        });
    };


    FuzzySearch.generateFields = function (obj, fieldlist) {

        if(!fieldlist.length) return [obj.toString()];

        var indexed_fields = [];
        for (var i = 0; i < fieldlist.length; i++) {
            FuzzySearch._collectValues(obj, fieldlist[i].split("."), indexed_fields, 0)
        }
        return indexed_fields;

    };

    FuzzySearch.getField = function (obj, field) {

        if(!field.length) return obj.toString();

        var indexed_fields = [];
        FuzzySearch._collectValues(obj, field.split("."), indexed_fields, 0);
        return indexed_fields[0] || "";

    };

    FuzzySearch._collectValues = function (obj, parts, list, level) {

        var key, i;
        var nb_level = parts.length;

        while( level < nb_level){

            key = parts[level];
            if(key === "*") break;
            if(!(key in obj)) return list;
            obj = obj[key];
            level++

        }

        var type = Object.prototype.toString.call(obj);
        var isArray  = ( type === '[object Array]'  );
        var isObject = ( type === '[object Object]' );


        if (level == nb_level) {

            if (isArray) {
                for (i = 0; i < obj.length; i++) {
                    list.push(obj[i].toString())
                }
            }

            else if(isObject){
                for (key in obj){
                    if(obj.hasOwnProperty(key)){
                        list.push(obj[key].toString())
                    }
                }
            }

            else list.push(obj.toString());

        }

        else if( key === "*" ) {

            level++;
            if (isArray){
                for (i = 0; i < obj.length; i++) {
                    FuzzySearch._collectValues(obj[i], parts, list, level);
                }
            }
            else if(isObject){
                for (key in obj){
                    if(obj.hasOwnProperty(key)){
                        FuzzySearch._collectValues(obj[key], parts, list, level);
                    }
                }
            }

        }


        return list;

    };


    // Adapted from paper:
    // A fast and practical bit-vector algorithm for
    // the Longest Common Subsequence problem
    // Maxime Crochemore et Al.
    //
    // With modification from
    // Bit-parallel LCS-length computation revisited (H Hyyrö, 2004)
    // http://www.sis.uta.fi/~hh56766/pubs/awoca04.pdf
    //
    // Precalculate aMap to search a in mulitple b
    // aMap = FuzzySearch.bitvector(a)
    //
    // Length of LCS (LLCS) is related to edit distance by
    //       2×LLCS(A, B)= n + m − ed(A, B)
    //
    // where ed is the simple edit distance (only insertion and deletion)
    // and m, n are size of A and B.
    //
    // length of lcs is then compared
    // to length of both a and b to make a score
    // this, togheter with bonus_prefix give a score
    // similar in idea to a Jaro–Winkler score
    //


    FuzzySearch.prototype.score = function(a, b){
        return FuzzySearch.score(a, b, this)
    };

    FuzzySearch.score = function (a, b, options) {

        if (options == undefined) options = _defaults;

        //do as much work as possible in as bit-parallel computation
        if( b.length > a.length && b.length < BVMAXSIZE){var tmp=a; a=b; b=tmp;}

        var aMap = FuzzySearch.bitVector(a);
        return FuzzySearch.score_map(a, b, aMap, options.bonus_match_start);

    };

    // Main score function
    // This one do not check for input
    FuzzySearch.score_map = function (a, b, aMap, bonus_prefix) {

        var i, j, lcs_len;
        var m = a.length;
        var n = b.length;

        var k = m < n ? m : n;
        if (k == 0) return 0;

        //normalize score against length of both inputs
        var sz_score = (m + n) / ( 2.0 * m * n);

        //common prefix is part of lcs
        var prefixlen = 0;
        if(a === b) prefixlen = k; //speedup equality
        else{ for (i = 0; i < k && (a[i] === b[i]); i++) prefixlen++;}

        //shortest string consumed
        if (prefixlen == k) {
            lcs_len = prefixlen;
            return sz_score * lcs_len * lcs_len + bonus_prefix*prefixlen;
        }

        //alternative algorithm for large string
        if(aMap.type==="posvector"){
            lcs_len = FuzzySearch.llcs_large(a,b,aMap,prefixlen);
            return sz_score * lcs_len * lcs_len + bonus_prefix*prefixlen;
        }

        m -= prefixlen;
        var mask = ( 1 << m ) - 1;
        var S = mask, M, U;

        for (j = prefixlen; j < n; j++) {
            // bit shift operator coerce undefined to 0
            // tested in jsperf: not testing if(key in map)
            // make this calculation twice as fast
            M = aMap[b[j]] >> prefixlen;
            U = S & M;
            S = (S + U) | (S - U); // Hyyrö, 2004 S=V'=~V

        }

        // lcs_len is number of 0 in S (at position lower than m)
        // inverse S, mask it, then do "popcount" operation on 32bit
        S = ~S & mask;
        lcs_len = 0;
        while (S){ S &= S - 1 ; lcs_len++ }

        //
        // Above loop iterate for each "1" in S
        // Alternative below is "constant time" no matter the number of bit set.
        //
        // However JSperf show loop worst case scenario (2^n-1) is equal or faster(depend on browser)
        // than constant time option. If there's only a few matches loop should improve even more.
        // As a bonus it's shorter.
        //
        // S = S - ((S >> 1) & 0x55555555);
        // S = (S & 0x33333333) + ((S >> 2) & 0x33333333);
        // lcs_len = (((S + (S >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
        //

        lcs_len += prefixlen;
        return sz_score * lcs_len * lcs_len + bonus_prefix *prefixlen;

    };



    //
    // Need one bit buffer to prevent overflow on (S + U) | (S - U)
    // We'll consider only the first BVMAXSIZE char of token
    //

    function BV(){}
    BV.prototype.type = "bitvector";

    FuzzySearch.bitVector = function (token) {

        var map = new BV(), i;
        var len = token.length;

        //Large string, fallback to position by position algorithm
        if(len > BVMAXSIZE) return FuzzySearch.posVector(token);

        //bit or "|=" operator coerce undefined to 0
        for (i = 0; i < len; i++) {
            map[token[i]] |= (1 << i)
        }

        return map;
    };

    //
    // Similar as bitvector but position is recorded as an integer in an array
    // instead of a bit in an integer
    //

    function PV(){}
    PV.prototype.type = "posvector";

    FuzzySearch.posVector = function(pattern){

        var m = pattern.length;
        var i, c;
        var map = new PV();

        for(i=0;i<m;i++){
            c = pattern[i];
            if(c in map){
                map[c].push(i);
            }else{
                map[c] = [i];
            }
        }

        for(c in map){
            if(map.hasOwnProperty(c)){
                map[c].push(Infinity);
            }
        }

        return map;

    };

    // An input sensitive online algorithm for LCS computation
    // Heikki Hyyro 2009
    //
    // We fill the dynamic programing table line per line
    // but instead of storing the whole line we only store position where the line increase
    // ( bitvector algorythm store increase yes/no as a bit) this time we will store sequence
    // of one or more consecutive increase.
    //
    // This allow to take advantage of common substring. For example "sur" in "surgery" vs "gsurvey".
    // One the block is formed it'll act as a single unit for the rest of computation.
    // The algorithm also take advantage of region without matches by not registering block at those region.
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
    //
    //  Two consecutive increase point without match between them ?
    //  => Copy from last line.
    //
    //  An increase point and a match at the same position ?
    //  => Copy from last line.
    //
    // The pattern that trigger a change from last line is:
    //  => first match between two increase point <=
    //
    // Match at position 4 is dominant, it make the value increase form 2 to 3.
    // Match at position 6 is recessive, it also make value from 2 to 3 BUT value for the line was already 3.
    //       All thing considered that match point could have been removed
    //
    // When registering a dominant match, we'll either
    //   - grow an existing block if the math happens right after one
    //   - start a new block.
    //
    // Because match make increase point happens sooner
    // we also need to remove one increase point from following block.
    // if the initial length was 1, the length is now 0 and block is skipped
    // otherwise it is copied to current line.
    //

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
        if(prefix==undefined) prefix = 0;

        if(prefix)
            last_line = [ [0,prefix], [ Infinity, Infinity] ] ;
        else
            last_line =  [[ Infinity, Infinity]];

        var lcs_len = prefix;

        var match_list, match_index;
        var block, block_index;

        var n = b.length,j;
        for (j = prefix; j < n; j++) {

            //Each line we process a single character of b
            match_list = aMap[b[j]];
            if (match_list == undefined) continue;

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
            while( ++block_index < nblock){

                //Place cursor just after last block
                last_end = block_end;

                //Read end block
                block = last_line[block_index];
                block_start = block[0]; //Encode block as [s,e[
                block_end = block[1]; //End is position of char that follow last.

                //get next match from list of matches
                while (match_pos < last_end) {
                    match_pos = match_list[++match_index];
                }

                // This cover two case
                // a) no match between two block
                // b) block happens after last match (so match_pos=Infinity).
                //    At the last block, this will append closing "sentinel" to line
                if (block_start <= match_pos){
                    current_line[++line_index] = block;
                    continue;
                }

                //
                // If we have reached here, we have a dominant match !
                // Decide where to register the match ...
                //

                if (match_pos == last_end) {
                    //End of last block ? (step a.ii)
                    current_line[line_index][1]++;
                }
                else {
                    //Or start a new block ? ( step a.i)
                    current_line[++line_index] = [match_pos, match_pos+1];
                }

                // if not empty, append next block to current line (step a.iii)
                // (this condition reject "sentinel", it'll get added just after the for loop)
                if ( block_end-block_start > 1  ) {
                    block[0]++; // Move start by one
                    current_line[++line_index] = block;
                }

            }

            // If the line finish with a match:
            //  a) llcs at end of this line is one greater than last line, increase score
            //  b) we still need to append sentinel
            if (block_start > match_pos){
                current_line[++line_index] = block;
                lcs_len++
            }

            last_line.length = 0;
            last_line = current_line;

            //console.log(JSON.stringify(last_line));
            //console.log(lcs_len)

        }

        return lcs_len;

    };

    FuzzySearch.prototype.highlight = function (a, b) {
        return FuzzySearch.highlight(a, b, this)
    };

    FuzzySearch.highlight = function (a, b, options) {

        if(options==undefined) options = _defaults;

        //var time_start = performance.now();

        var open_string = options.highlight_before;
        var close_string = options.highlight_after;

        var aa = FuzzySearch.normalize(a);
        var bb = FuzzySearch.normalize(b);

        var a_tokens = aa.split(" ");
        var b_tokens = bb.split(" ");
        var disp_tokens = b.split(/\s+/);

        // enforce maximum number of token in a
        // after max, token are lumped together a big one
        var nb_max_tokens = options.max_search_tokens;
        if (a_tokens.length > nb_max_tokens + 1) {
            var extra = a_tokens.splice(nb_max_tokens).join(" ");
            a_tokens.push(extra);
        }

        var match_list = [];
        var match_score = FuzzySearch.matchTokens(b_tokens, a_tokens, match_list, options);
        var strArr = [];

        //shortcut no match
        if (match_score == 0) return b;

        //Test "spacebar is broken" no token match
        var fused_score = FuzzySearch.score(aa, bb, options);
        if (fused_score > match_score) {
            //undo tokens
            a_tokens = [aa];
            b_tokens = [bb];
            disp_tokens = [disp_tokens.join(" ")];
            match_list = [0];
        }


        for (var j = 0; j < disp_tokens.length; j++) {

            var i = match_list[j];

            if (i == -1) {
                strArr.push(disp_tokens[j] + " ");
                continue;
            }

            var ta = a_tokens[i];
            var tb = b_tokens[j];
            var td = disp_tokens[j];
            var curr = 0;

            var start_positions = [];
            var end_positions = [];
            FuzzySearch.align(ta, tb, start_positions, end_positions);
            var len = start_positions.length;

            for (var k = 0; k < len; k++) {

                var s = start_positions[k];
                var e = end_positions[k];
                if (s > curr) strArr.push(td.substring(curr, s));
                strArr.push( open_string + td.substring(s, e) + close_string);
                curr = e;

            }

            strArr.push(td.substring(curr) + " ");

        }

        //var time_end = performance.now();
        //console.log("Highlight took " + (time_end-time_start) + " milliseconds.");

        return strArr.join('');

    };


    //
    // Smith-Waterman-Gotoh local Alignment
    //
    // Smith&Waterman worked the idea of local alignment
    // While Gotoh 82  worked on affine gap penalty.
    //
    // This is the basic algorithm with some optimisation to use less space.
    // JAligner has been used as a reference implementation to debug.
    // Some of their implementation detail to save memory has been reused here.
    //
    // See pseudo-code on
    // http://jaligner.sourceforge.net/api/jaligner/SmithWatermanGotoh.html
    //
    //

    FuzzySearch.align = function (a, b, seq_start, seq_end, options) {

        if(options==undefined) options = _defaults;

        var wm = 1.0;   // score to making a match
        var wo = -0.1;  // score to open a gap
        var we = -0.01; // score to continue an open gap

        var STOP = 0; //Traceback direction constant
        var UP = 1;
        var LEFT = 2;
        var DIAGONAL = 3;

        var msz = options.highlight_tk_max_size;
        var m = Math.min(a.length + 1, msz);
        var n = Math.min(b.length + 1, msz);

        // Comon prefix is part of lcs,
        // but not necessarily part of best alignment  (it can introduce an extra gap)
        // however prefix  make sens in an autocomplete scenario and speed things up
        //
        var i, j;
        var k = m < n ? m : n;
        var prefixlen = 0;

        if(a===b){
            //speedup equality
            prefixlen = m;
            m = 0;
        }
        else if (options.highlight_prefix) {
            for (i = 0; i < k && (a[i] === b[i]); i++) prefixlen++;

            if (prefixlen) {
                a = a.substring(prefixlen);
                b = b.substring(prefixlen);

                m -= prefixlen;
                n -= prefixlen;
            }
        }

        var vmax = 0, imax = 0, jmax = 0;


        var traceback = new Array(m * n);
        var pos = n - 1;

        //m,n = length+1
        if (m > 1 && n > 1) {

            var vrow = new Array(n), vd, v, align;
            var gapArow = new Array(n), gapA, gapB = 0;

            for (j = 0; j < n; j++) {
                gapArow[j] = 0;
                vrow[j] = 0;
                traceback[j] = STOP;
            }

            for (i = 1; i < m; i++) {

                gapB = 0;
                vd = vrow[0];

                pos++;
                traceback[pos] = STOP;

                for (j = 1; j < n; j++) {

                    //
                    // Reference "pseudocode"
                    // We try to fill that table, but using o(n) instead o(m*n) memory
                    // If we need traceback we still need o(m*n) but we store a single table instead of 3
                    //
                    // F[i][j] = f =  Math.max(F[i - 1][j] + we, V[i - 1][j] + wo );
                    // E[i][j] = e = Math.max(E[i][j - 1] + we, V[i][j - 1] + wo );
                    // align = (a[i - 1] === b[j - 1]) ? V[i - 1][j - 1] + wm : -Infinity;
                    // V[i][j] = v = Math.max(e, f, align, 0);
                    //

                    // Score the options
                    gapA = gapArow[j] = Math.max(gapArow[j] + we, vrow[j] + wo); //f
                    gapB = Math.max(gapB + we, vrow[j - 1] + wo); //e
                    align = ( a[i - 1] === b[j - 1] ) ? vd + wm : -Infinity;
                    vd = vrow[j];

                    v = vrow[j] = Math.max(align, gapA, gapB, 0);

                    // Determine the traceback direction
                    pos++;  //pos = i * n + j;
                    switch (v) {

                        // what triggered the best score ?

                        case align:
                            traceback[pos] = DIAGONAL;

                            if (v > vmax) {
                                vmax = v;
                                imax = i;
                                jmax = j;
                            }

                            break;

                        case gapB:
                            traceback[pos] = LEFT;
                            break;

                        case gapA:
                            traceback[pos] = UP;
                            break;

                        default:
                            traceback[pos] = STOP;
                            break;

                    }


                }
            }


        }

        // - - - - - - - - -
        //     TRACEBACK
        // - - - - - - - - -

        var bridge = options.highlight_bridge_gap;
        var last_match = 0;

        if (vmax > 0) {

            // backtrack to aligned sequence
            // record start and end of substrings
            // vmax happens at the end of last substring

            i = imax;
            j = jmax;
            pos = i * n + j;
            last_match = jmax;
            seq_end.push(jmax + prefixlen);


            var backtrack = true;
            while (backtrack) {

                switch (traceback[pos]) {

                    case UP:
                        i--;
                        pos -= n;
                        break;

                    case LEFT:
                        j--;
                        pos--;
                        break;

                    case DIAGONAL:

                        // if we have traversed a gap
                        // record start/end of sequence
                        // (unless we want to bridge the gap)

                        if (last_match - j > bridge) {
                            seq_start.push(last_match + prefixlen);
                            seq_end.push(j + prefixlen);
                        }

                        j--;
                        i--;
                        last_match = j;
                        pos -= n + 1;
                        break;

                    case STOP:
                    default :
                        backtrack = false;

                }

            }

            //first matched char
            seq_start.push(last_match + prefixlen);

        }


        if (prefixlen) {

            if (last_match > 0 && last_match <= bridge) {

                //bridge last match to prefix ?
                seq_start[seq_start.length - 1] = 0

            } else {

                //add prefix to matches
                seq_start.push(0);
                seq_end.push(prefixlen);

            }

        }

        //array were build backward, reverse to sort
        seq_start.reverse();
        seq_end.reverse();

        return vmax + prefixlen;


    };


    //
    // Each query token is matched against a field token
    // or against nothing (not in field)
    //
    // a: [paint] [my] [wall]
    // b: [wall] [painting]
    //
    // match: [1, -1, 0]
    //
    // if a[i] match b[j]
    //      then match[i] = j
    //
    // if a[i] match nothing
    //      then match[i] = -1
    //
    // return match score
    // take vector match by reference to output match detail
    //
    // Ideal case:
    // each token of "a" is matched against it's highest score(a[i],b[j])
    //
    // But in case two token have the same best match
    // We have to check for another pairing, giving highest score
    // under constraint of 1:1 exclusive match
    //
    // To do that we check all possible pairing permutation,
    // but we restrict ourselves to a set of plausible pairing.
    //
    // That is a token a will only consider pairing with a score at least
    //     thresh_relative_to_best * [highest score]
    //



    FuzzySearch.matchTokens = function (a_tokens, b_tokens, match, options) {

        if(options==undefined) options = _defaults;

        var minimum_match = options.minimum_match;
        var bonus_match_start = options.bonus_match_start;
        var best_thresh = options.thresh_relative_to_best;

        var i, j, row;
        var C = [];

        var m = a_tokens.length;
        var n = b_tokens.length;

        //
        // to minimise recursion depth, "a" should be smaller than "b"
        // we can flip the problem if we believe we can save enough
        // to justify to cost if flipping it back at the end
        //

        var flip = false;
        if(m>1 && n>1 && m-n>10){
            //switch a, b
            var tmp = a_tokens; a_tokens = b_tokens; b_tokens = tmp;
            i = m; m = n;  n = i;
            flip = true;
        }


        var a_maps = _map(a_tokens,FuzzySearch.bitVector);
        var a_tok, b_tok, a_mp;

        var rowmax = minimum_match, imax = -1, jmax = -1, v;
        var matchcount = 0;
        var thresholds = [];

        for (i = 0; i < m; i++) {

            row = [];
            match[i] = -1;
            rowmax = minimum_match;

            a_tok = a_tokens[i];
            if (!a_tok.length) continue;

            a_mp = a_maps[i];

            for (j = 0; j < n; j++) {

                b_tok = b_tokens[j];
                if (!b_tok.length) continue;

                v = FuzzySearch.score_map(a_tok, b_tok, a_mp, bonus_match_start);
                row[j] = v;

                if (v > minimum_match) matchcount++;

                if (v > rowmax) {
                    rowmax = v;
                    imax = i;
                    jmax = j;
                }

            }

            thresholds[i] = rowmax;

            C[i] = row;
        }

        //Shortcut: no match
        if (matchcount == 0) return 0;

        //Shortcut: single possible pairing
        if (matchcount == 1) {
            match[imax] = jmax;
            if(flip) FuzzySearch._flipmatch(match,n);
            return rowmax
        }


        //Only consider matching close enough to best match
        for (i = 0; i < a_tokens.length; i++) {
            thresholds[i] = Math.max(best_thresh * thresholds[i], minimum_match);
        }


        var score = FuzzySearch._matchScoreGrid(C,match,thresholds);

        //Flip back the problem if necessary
        if(flip) FuzzySearch._flipmatch(match,n);

        return score;

    };

    FuzzySearch._matchScoreGrid = function (C, match, thresholds) {

        var ilen = C.length;
        var i, j;

        //Traverse score grid to find best permutation
        var scoretree = [];
        for (i = 0; i < ilen; i++) {
            scoretree[i] = {};
        }

        var score = FuzzySearch._buildScoreTree(C, scoretree, 0, 0, thresholds);

        var used = 0, item;

        for (i = 0; i < ilen; i++) {

            item = scoretree[i][used];
            if (!item) break;
            j = item[1];
            match[i] = j;
            if (j > -1) used |= (1 << j);

        }


        return score
    };

    //
    // Cache tree:
    //
    // Given 5 node: 1,2,3,4,5
    //
    //  What is the best match ...
    //    - knowing that we have passed thru 1->2->3
    //    - knowing that we have passed thru 2->3->1
    //    - knowing that we have passed thru 3->1->2
    //
    //  All those question have the same answer
    //  because they are equivalent to match {4,5} againt {4,5}
    // ( in an alternate pass we can match {1,3} againt {4,5} for example )
    //
    // We store match in j in a bit vector of size 32
    //
    // In addition of saving computation, the cache_tree data structure is used to
    // trace back the best permutation !
    //
    // In addition of quick testing if an item is already used, used_mask serve
    // as a key in cache_tree (in addition to level). Ideal key would be a list of available trial
    // but, used & available are complementary vector (~not operation) so used is a perfeclty valid key too...

    FuzzySearch._buildScoreTree = function (C, cache_tree, used_mask, depth, score_thresholds) {

        var ilen = C.length;
        var jlen = C[depth].length;
        if(jlen>32) jlen = 32;

        var i, j, score;
        var include_thresh = score_thresholds[depth];
        var bestscore = 0, bestindex = -1;
        var has_childs = (depth < ilen - 1);
        var child_tree = cache_tree[depth+1], child_key;

        for (j = 0; j < jlen; j++) {

            var bit = 1<<j;

            //if token previously used, skip
            if(used_mask & bit) continue;

            //score for this match
            score = C[depth][j];

            //too small of a match, skip
            if (score < include_thresh) continue;

            //score for child match
            //if we already have computed this sub-block get from cache
            if(has_childs){
                child_key = used_mask | bit;
                if(child_key in  child_tree) score += child_tree[child_key][0];
                else score += FuzzySearch._buildScoreTree(C, cache_tree, child_key, depth + 1, score_thresholds);
            }

            if (score > bestscore) {
                bestscore = score;
                bestindex = j;
            }

        }

        //try the move of "do not match this token against anything"
        if(has_childs) {

            child_key = used_mask;
            if(child_key in  child_tree) score = child_tree[child_key][0];
            else  score = FuzzySearch._buildScoreTree(C, cache_tree, child_key, depth + 1, score_thresholds);

            if (score > bestscore) {
                bestscore = score;
                bestindex = -1;
            }

        }


        cache_tree[depth][used_mask] = [bestscore,bestindex];
        return bestscore;


    };


    FuzzySearch._flipmatch = function (match, newlen) {

        var i,j;
        var ref = match.slice();
        match.length = newlen;

        for(i=0;i<newlen;i++){
            match[i] = -1;
        }

        for(i=0;i<ref.length;i++){
            j = ref[i];
            if( j>-1 && j<newlen ) match[j] = i;
        }

    };

    return FuzzySearch;

})();

//
// Reference implementation to debug
// Might need to swap input to match internal of a given algorithm
//

/*
function lcs(a,b) {

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
    for (i = 1; i < m; i++){
        for (j = 1; j < n; j++) {
            C[i][j] = (a[i] === b[j]) ? C[i - 1][j - 1] + 1 : Math.max(C[i][j - 1], C[i - 1][j]);
        }
        console.log(JSON.stringify(C[i]));
    }

    //backtrack
    i--; j--;
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
}
*/
