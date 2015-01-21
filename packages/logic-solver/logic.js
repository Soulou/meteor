Logic = {};

Logic._MiniSat = MiniSat; // Expose for testing and poking around

// WholeNumber: a non-negative integer (0 is allowed)
Logic.WholeNumber = Match.Where(function (x) {
  return Match.test(x, Match.Integer) && x >= 0;
});

Logic.NumTerm = Match.Where(function (x) {
  return Match.test(x, Match.Integer) && x !== 0;
});

Logic.NameTerm = Match.Where(function (x) {
  return (typeof x === 'string') && (!! x);
});

// Term: a variable name or variable number, optionally
// negated (meaning "boolean not").  For example,
// `1`, `-1`, `"foo"`, or `"-foo"`.  All variables have
// internal numbers that start at 1, so "foo" might be
// variable number 1, for example.  Any number of leading
// "-" will be parsed in the string form, but we try to
// keep it to either one or zero of them.
Logic.Term = Match.OneOf(Logic.NameTerm, Logic.NumTerm);

// Takes a Formula or Term, returns a Formula or Term.
// Unlike other operators, if you give it a Term,
// you will get a Term back (of the same type, NameTerm
// or NumTerm).
Logic.not = function (operand) {
  check(operand, Logic.FormulaOrTerm);
  if (operand instanceof Logic.Formula) {
    return new Logic.NotFormula(operand);
  } else {
    // Term
    if (typeof operand === 'number') {
      return -operand;
    } else if (operand.charAt(0) === '-') {
      return operand.slice(1);
    } else {
      return '-' + operand;
    }
  }
};

Logic.TRUE = "$T";
Logic.FALSE = "$F";

Logic.Formula = function () {};
// Returns a list of Clauses that together require the Formula to be
// true, or false (depending on isTrue; both cases must be
// implemented).  A single Clause may also be returned.  The
// implementation should call the termifier to convert terms and
// formulas to NumTerms specific to a solver instance, and use them to
// construct a Logic.Clause.
Logic.Formula.prototype.generateClauses = function (isTrue, termifier) {
  throw new Error("Cannot generate this Formula; it must be expanded");
};
// All Formulas have a globally-unique id so that Solvers can track them.
// It is assigned lazily.
Logic.Formula._nextGuid = 1;
Logic.Formula.prototype._guid = null;
Logic.Formula.prototype.guid = function () {
  if (this._guid === null) {
    this._guid = Logic.Formula._nextGuid++;
  }
  return this._guid;
};

Logic.FormulaOrTerm = Match.OneOf(Logic.Formula, Logic.Term);

Logic.Clause = function (/*formulaOrArray, ...*/) {
  var terms = _.flatten(arguments);
  check(terms, [Logic.NumTerm]);
  this.terms = terms; // immutable [NumTerm]
};

// Returns a new Clause with the extra term or terms appended
Logic.Clause.prototype.append = function (/*formulaOrArray, ...*/) {
  return new Logic.Clause(this.terms.concat(_.flatten(arguments)));
};

Logic.Solver = function () {
  this.clauses = []; // mutable [Clause]
  this._num2name = [null]; // no 0th var
  this._name2num = {}; // (' '+vname) -> vnum

  // true and false
  this._F = this.getVarNum("$F", true); // 1
  this._T = this.getVarNum("$T", true); // 2
  this._F_used = false;
  this._T_used = false;
  // (it's important that these clauses are elements 0 and 1
  // of the clauses array)
  this.clauses.push(new Logic.Clause(-this._F));
  this.clauses.push(new Logic.Clause(this._T));

  this._formulaInfo = {}; // Formula guid -> info object
  // For generating formula names like "or1", "or2", "and1", "and2"
  this._nextFormulaNumByType = {}; // Formula type -> next var id
  // Map of Formulas whose info has `false` for either
  // `occursPositively` or `occursNegatively`
  this._ungeneratedFormulas = {}; // varNum -> Formula

  this._numClausesAddedToMiniSat = 0;
  this._unsat = false; // once true, no solution henceforth
  this._minisat = null; // created lazily
};

// Get a var number for vname, assigning it a number if it is new.
Logic.Solver.prototype.getVarNum = function (vname, _internal) {
  var key = ' '+vname;
  if (_.has(this._name2num, key)) {
    return this._name2num[key];
  } else {
    if (vname.charAt(0) === "$" && ! _internal) {
      throw new Error("Only generated variable names can start with $");
    }
    var vnum = this._num2name.length;
    this._name2num[key] = vnum;
    this._num2name.push(vname);
    return vnum;
  }
};

Logic.Solver.prototype.getVarName = function (vnum) {
  check(vnum, Match.Integer);
  var num2name = this._num2name;
  if (vnum < 1 || vnum >= num2name.length) {
    throw new Error("Bad variable num: " + vnum);
  } else {
    return num2name[vnum];
  }
};

// Converts Terms to NumTerms (if they aren't already).  This is done
// when a Formula creates Clauses for a Solver, since Clauses require
// NumTerms.  Takes a Term or an array.  For example, [-3, "-foo"] might
// become [-3, -4].
Logic.Solver.prototype.toNumTerm = function (t) {
  var self = this;

  if (_.isArray(t)) {
    check(t, [Logic.Term]);
    return _.map(t, _.bind(self.toNumTerm, self));
  } else {
    check(t, Logic.Term);
  }

  if (typeof t === 'number') {
    return t;
  } else { // string
    var not = false;
    while (t.charAt(0) === '-') {
      t = t.slice(1);
      not = ! not;
    }
    var n = self.getVarNum(t);
    return (not ? -n : n);
  }
};

// Converts Terms to NameTerms (if they aren't already).
// Takes a Term or an array.
Logic.Solver.prototype.toNameTerm = function (t) {
  var self = this;

  if (_.isArray(t)) {
    check(t, [Logic.Term]);
    return _.map(t, _.bind(self.toNameTerm, self));
  } else {
    check(t, Logic.Term);
  }

  if (typeof t === 'string') {
    // canonicalize, removing leading "--"
    while (t.slice(0, 2) == '--') {
      t = t.slice(2);
    }
    return t;
  } else { // number
    var not = false;
    if (t < 0) {
      not = true;
      t = -t;
    }
    t = self.getVarName(t);
    if (not) {
      t = '-' + t;
    }
    return t;
  }
};

Logic.Solver.prototype._addClause = function (cls, _extraTerms) {
  var self = this;

  check(cls, Logic.Clause);

  var extraTerms = null;
  if (_extraTerms) {
    extraTerms = _extraTerms;
    check(extraTerms, [Logic.Term]);
  }

  var usedF = false;
  var usedT = false;

  var numRealTerms = cls.terms.length;
  if (extraTerms) {
    cls = cls.append(extraTerms);
  }

  _.each(cls.terms, function (t, i) {
    var v = (t < 0) ? -t : t;
    if (v === self._F) {
      usedF = true;
    } else if (v === self._T) {
      usedT = true;
    } else if (v < 1 || v >= self._num2name.length) {
      throw new Error("Bad variable number: " + v);
    } else if (i < numRealTerms) {
      self._useFormulaTerm(t);
    }
  });

  this._F_used = (this._F_used || usedF);
  this._T_used = (this._T_used || usedT);

  this.clauses.push(cls);
};

// When we actually use a Formula variable, generate clauses for it,
// based on whether the usage is positive or negative.  For example,
// if the Formula `Logic.or("X", "Y")` is represented by `$or1`, which
// is variable number 5, then when you actually use 5 or -5 in a clause,
// the clauses "X v Y v -5" (when you use 5) or "-X v 5; -Y v 5"
// (when you use -5) will be generated.
Logic.Solver.prototype._useFormulaTerm = function (t) {
  var self = this;
  check(t, Logic.NumTerm);
  var v = (t < 0) ? -t : t;

  if (_.has(self._ungeneratedFormulas, v)) {
    // using a Formula's var; maybe have to generate clauses
    // for the Formula
    var formula = self._ungeneratedFormulas[v];
    var info = self._getFormulaInfo(formula);
    var positive = t > 0;
    if (positive && ! info.occursPositively) {
      // generate clauses for the formula.
      // Eg, if we use variable `X` which represents the formula
      // `A v B`, add the clause `A v B v -X`.
      info.occursPositively = true;
      var clauses = self._generateFormula(true, formula);
      self._addClauses(clauses, [-v]);
    } else if ((! positive) && ! info.occursNegatively) {
      // Eg, if we have the term `-X` where `X` represents the
      // formula `A v B`, add the clauses `-A v X` and `-B v X`.
      info.occursNegatively = true;
      var clauses = self._generateFormula(false, formula);
      self._addClauses(clauses, [v]);
    }
    if (info.occursPositively && info.occursNegatively) {
      delete self._ungeneratedFormulas[v];
    }
  }
};

Logic.Solver.prototype._addClauses = function (array, _extraTerms) {
  check(array, [Logic.Clause]);
  var self = this;
  _.each(array, function (cls) { self._addClause(cls, _extraTerms); });
};

Logic.Solver.prototype.require = function (/*formulaOrArray, ...*/) {
  this._requireForbidImpl(true, _.flatten(arguments));
};

Logic.Solver.prototype.forbid = function (/*formulaOrArray, ...*/) {
  this._requireForbidImpl(false, _.flatten(arguments));
};

Logic.Solver.prototype._requireForbidImpl = function (isRequire, formulas) {
  var self = this;
  check(formulas, [Logic.FormulaOrTerm]);
  _.each(formulas, function (f) {
    if (f instanceof Logic.NotFormula) {
      self._requireForbidImpl(!isRequire, [f.operand]);
    } else if (f instanceof Logic.Formula) {
      var info = self._getFormulaInfo(f);
      if (info.varNum !== null) {
        var sign = isRequire ? 1 : -1;
        self._addClause(new Logic.Clause(sign*info.varNum));
      } else {
        self._addClauses(self._generateFormula(isRequire, f));
      }
      if (isRequire) {
        info.isRequired = true;
      } else {
        info.isForbidden = true;
      }
    } else {
      self._addClauses(self._generateFormula(isRequire, f));
    }
  });
};

Logic.Solver.prototype._generateFormula = function (isTrue, formula) {
  var self = this;
  check(formula, Logic.FormulaOrTerm);

  if (formula instanceof Logic.NotFormula) {
    return self._generateFormula(!isTrue, formula.operand);
  } else if (formula instanceof Logic.Formula) {
    var info = self._getFormulaInfo(formula);
    if ((isTrue && info.isRequired) ||
        (!isTrue && info.isForbidden)) {
      return [];
      } else if ((isTrue && info.isForbidden) ||
                 (!isTrue && info.isRequired)) {
        return [new Logic.Clause()]; // never satisfied clause
      } else {
        var termifier = {
          term: _.bind(self._formulaToTerm, self),
          clause: function (/*args*/) {
            var formulas = _.flatten(arguments);
            check(formulas, [Logic.FormulaOrTerm]);
            return new Logic.Clause(_.map(formulas, termifier.term));
          },
          generate: _.bind(self._generateFormula, self)
        };
        var ret = formula.generateClauses(isTrue, termifier);
        return _.isArray(ret) ? ret : [ret];
      }
  } else { // Term
    var t = self.toNumTerm(formula);
    var sign = isTrue ? 1 : -1;
    if (t === sign*self._T || t === -sign*self._F) {
      return [];
    } else if (t === sign*self._F || t === -sign*self._T) {
      return [new Logic.Clause()]; // never satisfied clause
    } else {
      return [new Logic.Clause(sign*t)];
    }
  }
};

// Get clause data as an array of arrays of integers,
// for testing and debugging purposes.
Logic.Solver.prototype._clauseData = function () {
  var clauses = _.pluck(this.clauses, 'terms');
  if (! this._T_used) {
    clauses.splice(1, 1);
  }
  if (! this._F_used) {
    clauses.splice(0, 1);
  }
  return clauses;
};

// Get clause data as an array of human-readable strings,
// for testing and debugging purposes.
// A clause might look like "A v -B" (where "v" represents
// and OR operator).
Logic.Solver.prototype._clauseStrings = function () {
  var self = this;
  var clauseData = self._clauseData();
  return _.map(clauseData, function (clause) {
    return _.map(clause, function (nterm) {
      var str = self.toNameTerm(nterm);
      if (/\s/.test(str)) {
        // write name in quotes for readability.  we don't bother
        // making this string machine-parsable in the general case.
        var sign = '';
        if (str.charAt(0) === '-') {
          // temporarily remove '-'
          sign = '-';
          str = str.slice(1);
        }
        str = sign + '"' + str + '"';
      }
      return str;
    }).join(' v ');
  });
};

Logic.Solver.prototype._getFormulaInfo = function (formula) {
  var self = this;
  var guid = formula.guid();
  if (! self._formulaInfo[guid]) {
    self._formulaInfo[guid] = {
      // We generate a variable when a Formula is used.  If the
      // variable is only used positively or only used negatively, we
      // can generate fewer clauses, using a method that relies on the
      // fact that the generated variable is unobservable so we can
      // get away without a bidirectional implication.
      varName: null,
      varNum: null,
      occursPositively: false,
      occursNegatively: false,
      isRequired: false,
      isForbidden: false
    };
  }
  return self._formulaInfo[guid];
};

// Takes a Formula or an array of Formulas, returns a NumTerm.
Logic.Solver.prototype._formulaToTerm = function (formula) {
  var self = this;

  if (_.isArray(formula)) {
    check(formula, [Logic.FormulaOrTerm]);
    return _.map(formula, _.bind(self._formulaToTerm, self));
  } else {
    check(formula, Logic.FormulaOrTerm);
  }

  if (formula instanceof Logic.NotFormula) {
    // shortcut that avoids creating a variable called
    // something like "not1" when you use Logic.not(formula).
    return Logic.not(self._formulaToTerm(formula.operand));
  } else if (formula instanceof Logic.Formula) {
    var info = this._getFormulaInfo(formula);
    if (info.isRequired) {
      return self._T;
    } else if (info.isForbidden) {
      return self._F;
    } else if (info.varNum === null) {
      // generate a Solver-local formula name like "or1"
      var type = formula.type;
      if (! this._nextFormulaNumByType[type]) {
        this._nextFormulaNumByType[type] = 1;
      }
      var numForVarName = this._nextFormulaNumByType[type]++;
      info.varName = "$" + formula.type + numForVarName;
      info.varNum = this.getVarNum(info.varName, true);
      this._ungeneratedFormulas[info.varNum] = formula;
    }
    return info.varNum;
  } else {
    // formula is a Term
    return self.toNumTerm(formula);
  }
};

Logic._defineFormula = function (constructor, typeName, methods) {
  check(constructor, Function);
  check(typeName, String);
  Meteor._inherits(constructor, Logic.Formula);
  constructor.prototype.type = typeName;
  if (methods) {
    _.extend(constructor.prototype, methods);
  }
};

Logic.or = function (/*formulaOrArray, ...*/) {
  var args = _.flatten(arguments);
  if (args.length === 0) {
    return Logic.FALSE;
  } else if (args.length === 1) {
    return args[0];
  } else {
    return new Logic.OrFormula(args);
  }
};

Logic.OrFormula = function (operands) {
  check(operands, [Logic.FormulaOrTerm]);
  this.operands = operands;
};

Logic._defineFormula(Logic.OrFormula, 'or', {
  generateClauses: function (isTrue, t) {
    if (isTrue) {
      // eg A v B v C
      return t.clause(this.operands);
    } else {
      // eg -A; -B; -C
      var result = [];
      _.each(this.operands, function (o) {
        result.push.apply(result, t.generate(false, o));
      });
      return result;
    }
  }
});

Logic.NotFormula = function (operand) {
  check(operand, Logic.FormulaOrTerm);
  this.operand = operand;
};

// No generation or simplification for 'not'; it is
// simplified away by the solver itself.
Logic._defineFormula(Logic.NotFormula, 'not');

Logic.and = function (/*formulaOrArray, ...*/) {
  var args = _.flatten(arguments);
  if (args.length === 0) {
    return Logic.TRUE;
  } else if (args.length === 1) {
    return args[0];
  } else {
    return new Logic.AndFormula(args);
  }
};

Logic.AndFormula = function (operands) {
  check(operands, [Logic.FormulaOrTerm]);
  this.operands = operands;
};

Logic._defineFormula(Logic.AndFormula, 'and', {
  generateClauses: function (isTrue, t) {
    if (isTrue) {
      // eg A; B; C
      var result = [];
      _.each(this.operands, function (o) {
        result.push.apply(result, t.generate(true, o));
      });
      return result;
    } else {
      // eg -A v -B v -C
      return t.clause(_.map(this.operands, Logic.not));
    }
  }
});

// Group `array` into groups of N, where the last group
// may be shorter than N.  group([a,b,c,d,e], 3) => [[a,b,c],[d,e]]
var group = function (array, N) {
  var ret = [];
  for (var i = 0; i < array.length; i += N) {
    ret.push(array.slice(i, i+N));
  }
  return ret;
};

Logic.xor = function (/*formulaOrArray, ...*/) {
  var args = _.flatten(arguments);
  if (args.length === 0) {
    return Logic.FALSE;
  } else if (args.length === 1) {
    return args[0];
  } else {
    return new Logic.XorFormula(args);
  }
};

Logic.XorFormula = function (operands) {
  check(operands, [Logic.FormulaOrTerm]);
  this.operands = operands;
};

Logic._defineFormula(Logic.XorFormula, 'xor', {
  generateClauses: function (isTrue, t) {
    var args = this.operands;
    var not = Logic.not;
    if (args.length > 3) {
      return t.generate(
        isTrue,
        Logic.xor(
          _.map(group(this.operands, 3), function (group) {
            return Logic.xor(group);
          })));
    } else if (isTrue) { // args.length <= 3
      if (args.length === 0) {
        return t.clause(); // always fail
      } else if (args.length === 1) {
        return t.clause(args[0]);
      } else if (args.length === 2) {
        var A = args[0], B = args[1];
        return [t.clause(A, B), // A v B
                t.clause(not(A), not(B))]; // -A v -B
      } else if (args.length === 3) {
        var A = args[0], B = args[1], C = args[2];
        return [t.clause(A, B, C), // A v B v C
                t.clause(A, not(B), not(C)), // A v -B v -C
                t.clause(not(A), B, not(C)), // -A v B v -C
                t.clause(not(A), not(B), C)]; // -A v -B v C
      }
    } else { // !isTrue, args.length <= 3
      if (args.length === 0) {
        return []; // always succeed
      } else if (args.length === 1) {
        return t.clause(not(args[0]));
      } else if (args.length === 2) {
        var A = args[0], B = args[1];
        return [t.clause(A, not(B)), // A v -B
                t.clause(not(A), B)]; // -A v B
      } else if (args.length === 3) {
        var A = args[0], B = args[1], C = args[2];
        return [t.clause(not(A), not(B), not(C)), // -A v -B v -C
                t.clause(not(A), B, C), // -A v B v C
                t.clause(A, not(B), C), // A v -B v C
                t.clause(A, B, not(C))]; // A v B v -C
      }
    }
  }
});

Logic.atMostOne = function (/*formulaOrArray, ...*/) {
  var args = _.flatten(arguments);
  if (args.length <= 1) {
    return Logic.TRUE;
  } else {
    return new Logic.AtMostOneFormula(args);
  }
};

Logic.AtMostOneFormula = function (operands) {
  check(operands, [Logic.FormulaOrTerm]);
  this.operands = operands;
};

Logic._defineFormula(Logic.AtMostOneFormula, 'atMostOne', {
  generateClauses: function (isTrue, t) {
     var args = this.operands;
     var not = Logic.not;
     if (args.length <= 1) {
       return []; // always succeed
     } else if (args.length === 2) {
       return t.generate(isTrue, Logic.not(Logic.and(args)));
     } else if (args.length === 3) {
       var A = args[0], B = args[1], C = args[2];
       if (isTrue) {
         // Pick any two args; at least one is false (they aren't
         // both true).  This strategy would also work for N > 3.
         return [t.clause(not(A), not(B)),
                 t.clause(not(A), not(C)),
                 t.clause(not(B), not(C))];
       } else { // !isTrue
         // Pick any two args; at least one is true (they aren't
         // both false).  This only works for N=3.
         return [t.clause(A, B), t.clause(A, C), t.clause(B, C)];
       }
     } else {
       // See the "commander variables" technique from:
       // http://www.cs.cmu.edu/~wklieber/papers/2007_efficient-cnf-encoding-for-selecting-1.pdf
       // But in short: At most one group has at least one "true",
       // and each group has at most one "true".  Formula generation
       // automatically generates the right implications.
       var groups = group(args, 3);
       var ors = _.map(groups, function (g) { return Logic.or(g); });
       if (groups[groups.length - 1].length < 2) {
         // Remove final group of length 1 so we don't generate
         // no-op clauses of one sort or another
         groups.length--;
       }
       var atMostOnes = _.map(groups, function (g) {
         return Logic.atMostOne(g);
       });
       return t.generate(isTrue, Logic.and(Logic.atMostOne(ors), atMostOnes));
     }
  }
});

Logic.implies = function (A, B) {
  check(arguments.length, 2);
  return new Logic.ImpliesFormula(A, B);
};

Logic.ImpliesFormula = function (A, B) {
  check(A, Logic.FormulaOrTerm);
  check(B, Logic.FormulaOrTerm);
  check(arguments.length, 2);
  this.A = A;
  this.B = B;
};

Logic._defineFormula(Logic.ImpliesFormula, 'implies', {
  generateClauses: function (isTrue, t) {
    return t.generate(isTrue, Logic.or(Logic.not(this.A), this.B));
  }
});

Logic.equiv = function (A, B) {
  check(arguments.length, 2);
  return new Logic.EquivFormula(A, B);
};

Logic.EquivFormula = function (A, B) {
  check(A, Logic.FormulaOrTerm);
  check(B, Logic.FormulaOrTerm);
  check(arguments.length, 2);
  this.A = A;
  this.B = B;
};

Logic._defineFormula(Logic.EquivFormula, 'equiv', {
  generateClauses: function (isTrue, t) {
    return t.generate(!isTrue, Logic.xor(this.A, this.B));
  }
});

Logic.exactlyOne = function (/*formulaOrArray, ...*/) {
  var args = _.flatten(arguments);
  if (args.length === 0) {
    return Logic.FALSE;
  } else if (args.length === 1) {
    return args[0];
  } else {
    return new Logic.ExactlyOneFormula(args);
  }
};

Logic.ExactlyOneFormula = function (operands) {
  check(operands, [Logic.FormulaOrTerm]);
  this.operands = operands;
};

Logic._defineFormula(Logic.ExactlyOneFormula, 'exactlyOne', {
  generateClauses: function (isTrue, t) {
    var args = this.operands;
    if (args.length < 3) {
      return t.generate(isTrue, Logic.xor(args));
    } else {
      return t.generate(isTrue, Logic.and(Logic.atMostOne(args),
                                          Logic.or(args)));
    }
  }
});

// List of 0 or more formulas or terms, which together represent
// a non-negative integer.  Least significant bit is first.  That is,
// the kth array element has a place value of 2^k.
Logic.Bits = function (formulaArray) {
  check(formulaArray, [Logic.FormulaOrTerm]);
  this.bits = formulaArray; // public, immutable
};

Logic.constantBits = function (wholeNumber) {
  check(wholeNumber, Logic.WholeNumber);
  var result = [];
  while (wholeNumber) {
    result.push((wholeNumber & 1) ? Logic.TRUE : Logic.FALSE);
    wholeNumber >>>= 1;
  }
  return new Logic.Bits(result);
};

// bits1 <= bits2
Logic.lessThanOrEqual = function (bits1, bits2) {
  return new Logic.LessThanOrEqualFormula(bits1, bits2);
};

Logic.LessThanOrEqualFormula = function (bits1, bits2) {
  check(bits1, Logic.Bits);
  check(bits2, Logic.Bits);
  check(arguments.length, 2);
  this.bits1 = bits1;
  this.bits2 = bits2;
};

var genLTE = function (bits1, bits2, t, notEqual) {
  var ret = [];
  // clone so we can mutate them in place
  var A = bits1.bits.slice();
  var B = bits2.bits.slice();
  if (notEqual && ! bits2.bits.length) {
    // can't be less than 0
    return t.clause();
  }
  // if A is longer than B, the extra (high) bits
  // must be 0.
  while (A.length > B.length) {
    var hi = A.pop();
    ret.push(t.clause(Logic.not(hi)));
    }
  // now B.length >= A.length
  // Let xors[i] be (A[i] xor B[i]), or just
  // B[i] if A is too short.
  var xors = _.map(B, function (b, i) {
    if (i < A.length) {
      return Logic.xor(A[i], b);
    } else {
      return b;
    }
  });

  // Suppose we are comparing 3-bit numbers, requiring
  // that ABC <= XYZ.  Here is what we require:
  //
  // * It is false that A=1 and X=0.
  // * It is false that A=X, B=1, and Y=0.
  // * It is false that A=X, B=Y, C=1, and Y=0.
  //
  // Translating these into clauses using DeMorgan's law:
  //
  // * A=0 or X=1
  // * (A xor X) or B=0 or Y=1
  // * (A xor X) or (B xor Y) or C=0 or Y=1
  //
  // Since our arguments are LSB first, in the example
  // we would be given [C, B, A] and [Z, Y, X] as input.
  // We iterate over the first argument starting from
  // the right, and build up a clause by iterating over
  // the xors from the right (note that there may be
  // more xors, because we may have been given [Z, Y, X, W]).
  for (var i = A.length-1; i >= 0; i--) {
    ret.push(t.clause(xors.slice(i+1), Logic.not(A[i]), B[i]));
  }
  if (notEqual) {
    ret.push.apply(ret, t.generate(true, Logic.or(xors)));
  }
  return ret;
};

Logic._defineFormula(Logic.LessThanOrEqualFormula, 'lte', {
  generateClauses: function (isTrue, t) {
    if (isTrue) {
      // bits1 <= bits2
      return genLTE(this.bits1, this.bits2, t, false);
    } else {
      // bits2 < bits1
      return genLTE(this.bits2, this.bits1, t, true);
    }
  }
});

// bits1 < bits2
Logic.lessThan = function (bits1, bits2) {
  return new Logic.LessThanFormula(bits1, bits2);
};

Logic.LessThanFormula = function (bits1, bits2) {
  check(bits1, Logic.Bits);
  check(bits2, Logic.Bits);
  check(arguments.length, 2);
  this.bits1 = bits1;
  this.bits2 = bits2;
};

Logic._defineFormula(Logic.LessThanFormula, 'lt', {
  generateClauses: function (isTrue, t) {
    if (isTrue) {
      // bits1 < bits2
      return genLTE(this.bits1, this.bits2, t, true);
    } else {
      // bits2 <= bits1
      return genLTE(this.bits2, this.bits1, t, false);
    }
  }
});

Logic.greaterThan = function (bits1, bits2) {
  return Logic.lessThan(bits2, bits1);
};

Logic.greaterThanOrEqual = function (bits1, bits2) {
  return Logic.lessThanOrEqual(bits2, bits1);
}

Logic.equalBits = function (bits1, bits2) {
  return new Logic.EqualBitsFormula(bits1, bits2);
};

Logic.EqualBitsFormula = function (bits1, bits2) {
  check(bits1, Logic.Bits);
  check(bits2, Logic.Bits);
  check(arguments.length, 2);
  this.bits1 = bits1;
  this.bits2 = bits2;
};

Logic._defineFormula(Logic.EqualBitsFormula, 'equalBits', {
  generateClauses: function (isTrue, t) {
    var A = this.bits1.bits;
    var B = this.bits2.bits;
    var nbits = Math.max(A.length, B.length);
    var facts = [];
    for (var i = 0; i < nbits; i++) {
      if (i >= A.length) {
        facts.push(Logic.not(B[i]));
      } else if (i >= B.length) {
        facts.push(Logic.not(A[i]));
      } else {
        facts.push(Logic.equiv(A[i], B[i]));
      }
    }
    return t.generate(isTrue, Logic.and(facts));
  }
});

Logic.HalfAdderSum = function (formula1, formula2) {
  check(formula1, Logic.FormulaOrTerm);
  check(formula2, Logic.FormulaOrTerm);
  check(arguments.length, 2);
  this.a = formula1;
  this.b = formula2;
};

Logic._defineFormula(Logic.HalfAdderSum, 'hsum', {
  generateClauses: function (isTrue, t) {
    return t.generate(isTrue, Logic.xor(this.a, this.b));
  }
});

Logic.HalfAdderCarry = function (formula1, formula2) {
  check(formula1, Logic.FormulaOrTerm);
  check(formula2, Logic.FormulaOrTerm);
  check(arguments.length, 2);
  this.a = formula1;
  this.b = formula2;
};

Logic._defineFormula(Logic.HalfAdderCarry, 'hcarry', {
  generateClauses: function (isTrue, t) {
    return t.generate(isTrue, Logic.and(this.a, this.b));
  }
});

Logic.FullAdderSum = function (formula1, formula2, formula3) {
  check(formula1, Logic.FormulaOrTerm);
  check(formula2, Logic.FormulaOrTerm);
  check(formula3, Logic.FormulaOrTerm);
  check(arguments.length, 3);
  this.a = formula1;
  this.b = formula2;
  this.c = formula3;
};

Logic._defineFormula(Logic.FullAdderSum, 'fsum', {
  generateClauses: function (isTrue, t) {
    return t.generate(isTrue, Logic.xor(this.a, this.b, this.c));
  }
});

Logic.FullAdderCarry = function (formula1, formula2, formula3) {
  check(formula1, Logic.FormulaOrTerm);
  check(formula2, Logic.FormulaOrTerm);
  check(formula3, Logic.FormulaOrTerm);
  check(arguments.length, 3);
  this.a = formula1;
  this.b = formula2;
  this.c = formula3;
};

Logic._defineFormula(Logic.FullAdderCarry, 'fcarry', {
  generateClauses: function (isTrue, t) {
    return t.generate(! isTrue,
                      Logic.atMostOne(this.a, this.b, this.c));
  }
});

// Implements the Adder strategy from the MiniSat+ paper:
// http://minisat.se/downloads/MiniSat+.pdf
// "Translating Pseudo-boolean Constraints into SAT"
//
// Takes a list of list of Formulas.  The first list is bits
// to give weight 1; the second is bits to give weight 2;
// and so on.  Returns a Bits.
var binaryWeightedSum = function (varsByWeight) {
  check(varsByWeight, [[Logic.FormulaOrTerm]]);
  // initialize buckets to a two-level clone of varsByWeight
  var buckets = _.map(varsByWeight, _.clone);
  var lowestWeight = 0; // index of the first non-empty array
  var output = [];
  while (lowestWeight < buckets.length) {
    var i = lowestWeight;
    var bucket = buckets[i];
    if (! bucket.length) {
      output.push(Logic.FALSE);
      lowestWeight++;
    } else if (bucket.length === 1) {
      output.push(bucket[0]);
      lowestWeight++;
    } else if (bucket.length === 2) {
      var sum = new Logic.HalfAdderSum(bucket[0], bucket[1]);
      var carry = new Logic.HalfAdderCarry(bucket[0], bucket[1]);
      bucket.length = 0;
      bucket.push(sum);
      buckets[i+1] = (buckets[i+1] || []);
      buckets[i+1].push(carry);
    } else {
      // Not clear whether it's better to take the three
      // vars from the start or end of the bucket, but
      // based on a quick test, the end seems faster for solving.
      var c = bucket.pop();
      var b = bucket.pop();
      var a = bucket.pop();
      var sum = new Logic.FullAdderSum(a, b, c);
      var carry = new Logic.FullAdderCarry(a, b, c);
      bucket.push(sum);
      buckets[i+1] = (buckets[i+1] || []);
      buckets[i+1].push(carry);
    }
  }
  return output;
};

var pushToNth = function (arrayOfArrays, n, newItem) {
  arrayOfArrays[n] = (arrayOfArrays[n] || []);
  arrayOfArrays[n].push(newItem);
};

Logic.weightedSum = function (formulas, weights) {
  check(formulas, [Logic.FormulaOrTerm]);
  check(weights, [Logic.WholeNumber]);
  if (! (formulas.length === weights.length && formulas.length)) {
    throw new Error("Formula array and weight array must be same length (> 0)");
  }
  var binaryWeighted = [];
  _.each(formulas, function (f, i) {
    var w = weights[i];
    var whichBit = 0;
    while (w) {
      if (w & 1) {
        pushToNth(binaryWeighted, whichBit, f);
      }
      w >>>= 1;
      whichBit++;
    }
  });

  return new Logic.Bits(binaryWeightedSum(binaryWeighted));
};

Logic.sum = function (/*formulaOrBitsOrArray, ...*/) {
  var things = _.flatten(arguments);
  check(things, [Match.OneOf(Logic.FormulaOrTerm, Logic.Bits)]);

  var binaryWeighted = [];
  _.each(things, function (x) {
    if (x instanceof Logic.Bits) {
      _.each(x.bits, function (b, i) {
        pushToNth(binaryWeighted, i, b);
      });
    } else {
      pushToNth(binaryWeighted, 0, x);
    }
  });

  return new Logic.Bits(binaryWeightedSum(binaryWeighted));
};

////////////////////////////////////////

Logic.Solver.prototype.solve = function (_assumpVar) {
  var self = this;
  if (_assumpVar !== undefined) {
    if (! (_assumpVar >= 1)) {
      throw new Error("_assumpVar must be a variable number");
    }
  }

  if (self._unsat) {
    return null;
  }

  if (! self._minisat) {
    self._minisat = new MiniSat();
  }

  while (self._numClausesAddedToMiniSat < self.clauses.length) {
    var i = self._numClausesAddedToMiniSat;
    var stillSat = self._minisat.addClause(self.clauses[i].terms);
    self._numClausesAddedToMiniSat++;
    if (! stillSat) {
      self._unsat = true;
      return null;
    }
  }
  self._minisat.ensureVar(this._num2name.length - 1);

  var stillSat = (_assumpVar ?
                  self._minisat.solveAssuming(_assumpVar) :
                  self._minisat.solve());
  if (! stillSat) {
    if (! _assumpVar) {
      self._unsat = true;
    }
    return null;
  }

  return new Logic.Solution(self, self._minisat.getSolution());
};

Logic.Solver.prototype.solveAssuming = function (formula) {
  check(formula, Logic.FormulaOrTerm);

  // Wrap the formula in a formula of type Assumption, so that
  // we always generate a var like `$assump123`, regardless
  // of whether `formula` is a Term, a NotFormula, an already
  // required or forbidden Formula, etc.
  var assump = new Logic.Assumption(formula);
  var assumpVar = this._formulaToTerm(assump);
  if (! (typeof assumpVar === 'number' && assumpVar > 0)) {
    throw new Error("Assertion failure: not a positive numeric term");
  }

  // Generate clauses as if we used the assumption variable in a
  // clause, in the positive.  So if we assume "A v B", we might get a
  // clause like "A v B v -$assump123" (or actually, "$or1 v
  // -$assump123"), as if we had used $assump123 in a clause.  Instead
  // of using it in a clause, though, we temporarily assume it to be
  // true.
  this._useFormulaTerm(assumpVar);

  var result = this.solve(assumpVar);
  // Tell MiniSat that we will never use assumpVar again.
  // The formula may be used again, however.  (For example, you
  // can solve assuming a formula F, and if it works, require F.)
  this._minisat.retireVar(assumpVar);
  return result;
};

Logic.Assumption = function (formula) {
  check(formula, Logic.FormulaOrTerm);
  this.formula = formula;
};

Logic._defineFormula(Logic.Assumption, 'assump', {
  generateClauses: function (isTrue, t) {
    if (isTrue) {
      return t.clause(this.formula);
    } else {
      return t.clause(Logic.not(this.formula));
    }
  }
});


Logic.Solution = function (_solver, _assignment) {
  this._solver = _solver;
  this._assignment = _assignment;
};

Logic.Solution.prototype.getMap = function () {
  var solver = this._solver;
  var assignment = this._assignment;
  var result = {};
  for (var i = 1; i < assignment.length; i++) {
    var name = solver.getVarName(i);
    if (name && name.charAt(0) !== '$') {
      result[name] = assignment[i];
    }
  }
  return result;
};
