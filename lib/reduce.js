var fs = require('fs');
var path = require('path');
var gonzales = require('gonzales-pe');

var NodeType = {
  ATRULE_RQ: 'atrulerq',
  BLOCK: 'block',
  DECLARATION: 'declaration',
  DELIMITER_D: 'declarationDelimiter',
  DELIMITER_P: 'propertyDelimiter',
  EXTEND: 'extend',
  FUNCTION: 'function',
  IDENTIFIER: 'ident',
  INCLUDE: 'include',
  INTERPOLATION: 'interpolation',
  LOOP: 'loop',
  MIXIN: 'mixin',
  PARENTHESIS: 'parentheses',
  PROPERTY: 'property',
  RULESET: 'ruleset',
  SELECTOR: 'selector',
  SIMPLE_SELECTOR: 'simpleSelector',
  STYLE_SHEET: 'stylesheet',
  VALUE: 'value',
  VARIABLE: 'variable'
};

function Reducer(opts) {
  this.selector = [];
  this.extend = {};
  this.mixins = {}
  this.vars = {};
  this.locals = {};
  this.varsFile = opts.varsFile;
  this.templatize = opts.templatize;

  if (!this.varsFile) throw 'No variables file specified.';
  if (!path.isAbsolute(this.varsFile)) {
    this.varsFile = path.resolve(opts.cwd || process.cwd(), this.varsFile);
  }

  var defaults = fs.readFileSync(this.varsFile, 'utf-8');
  var pattern = /(\$[^\s:]+)[\s:]/g;
  var match = pattern.exec(defaults);

  while (match) {
    this.vars[ match[1] ] = 1;
    match = pattern.exec(defaults);
  }
}

Reducer.prototype = {
  // List of removable node types:
  removeableTypes: [
    NodeType.DECLARATION,
    NodeType.EXTEND,
    NodeType.INCLUDE,
    NodeType.LOOP,
    NodeType.MIXIN,
    NodeType.RULESET
  ],

  // Checks if a type is removable:
  // constructs and caches types hash on first lookup.
  isRemovable: function(type) {
    return this.removeableTypes.indexOf(type) != -1;
  },

  /**
  * Drops a node from the tree:
  * the node's content is replaced by a single-line comment.
  */
  dropNode: function(node, desc) {
    node.content = ' ' + (desc || node.type);
    node.type = 'singlelineComment';
    return false;
  },

  /**
  * Collects local variable definitions that may
  * derrive from an override variable:
  * Ex: `@each $c in $keep-color`
  */
  setLocals: function(node) {
    var locals = {};
    var keep = false;
    var loop = node.toString().split('\n')[0];
    var pattern = /(\$[\w-]+)/g;
    var match = pattern.exec(loop);

    while (match) {
      locals[ match[1] ] = 1;
      keep = this.vars.hasOwnProperty(match[1]) || keep;
      match = pattern.exec(loop);
    }

    // Only keep these locals if there was a valid override within the loop:
    this.locals = keep ? locals : {};
  },

  /**
   * Methodology for recursively filtering a Sass abstract syntax tree (AST).
   * Each node is explored for relevant variables, and then pruned if irrelevant.
   * @param { object } node: a Gonzales Node object from a parsed AST.
   * @param { array } ancestry: an array of node-type strings prepresenting the current search path.
   * @return { boolean } returns true if the search branch should be retained.
   */
  reduceNode: function(node, parent) {
    var keep = false;

    // Track selector heirarchy while drilling into the tree:
    if (node.type === NodeType.SELECTOR) {
      this.selector.push(node.toString().trim());
    }

    // Track derivitive locals created by control-flow loops:
    else if (node.type === NodeType.LOOP) {
      this.setLocals(node);
    }

    // Keep variable declarations and overrides:
    else if (node.type === NodeType.VARIABLE && parent) {
      // Test if the var belongs to the set of override vars:
      var overrideVar = this.vars.hasOwnProperty(node.toString());
      // Test if the variable is keepable (includes local derivatives)
      var keepableVar = overrideVar || this.locals.hasOwnProperty(node.toString());
      // Check usage context to determin if variable is being read (versus written):
      var readingVar = (parent.type === NodeType.VALUE ||
                        parent.type === NodeType.INTERPOLATION ||
                        parent.type === NodeType.PARENTHESIS ||
                        parent.type === NodeType.LOOP);

      if (this.templatize && overrideVar && readingVar) {
        var id = node.first(NodeType.IDENTIFIER);
        node.type = NodeType.IDENTIFIER;
        node.content = '____'+ id.content +'____';
      }

      // Keep if the variable is a property being written ($banana: yellow;),
      // or if the variable is keepable and being read (color: $banana;).
      return  (parent.type === NodeType.PROPERTY) || (readingVar && keepableVar);
    }

    // Keep "@include mixin-name;" statements for keepable mixins:
    else if (node.type === NodeType.EXTEND) {
      var extend = node.toString().replace(/@extend\s+(.+)$/, '$1').trim();
      if (this.extend.hasOwnProperty(extend)) return true;
    }

    // Keep "@include mixin-name;" statements for keepable mixins:
    else if (node.type === NodeType.INCLUDE) {
      var include = node.toString().replace(/@include\s+(.+)$/, '$1').trim();
      if (this.mixins.hasOwnProperty(include)) return true;
    }

    // Drop all vars stylesheet includes:
    // This removes the overrideable variables from the compilation entirely.
    else if (node.type === NodeType.STYLE_SHEET && node.filepath === this.varsFile) {
      return this.dropNode(node, 'varsfile');
    }

    // Extend filter to all child nodes...
    if (Array.isArray(node.content)) {
      // Recursively filter on all node children:
      for (var i=0; i < node.content.length; i++) {
        keep = this.reduceNode(node.content[i], node) || keep;
      }
    }

    // Track mixin names that contain keepable variables:
    if (node.type === NodeType.MIXIN && keep) {
      var ident = node.first(NodeType.IDENTIFIER);
      if (ident && typeof ident.content === 'string') {
        this.mixins[ ident.content ] = 1;
      }
    }

    // Track valid rulesets for future use by @extend:
    // Remove last selector after traversing a ruleset.
    else if (node.type === NodeType.RULESET) {

      // Retain all selector names that are being kept:
      if (keep && this.selector.length) {
        this.extend[ this.selector.join(' ') ] = 1;
      }

      this.selector.pop();
    }

    // Clear local variables after completing a loop:
    else if (node.type === NodeType.LOOP) {
      this.locals = {};
    } 

    // If this is a removable node that we're NOT keeping, drop it:
    if (!keep && this.isRemovable(node.type)) {
      return this.dropNode(node);
    }

    return keep;
  },

  template: function(node) {
    var sass = require('node-sass');
    var scss = node.toString();
    
    console.log(scss);
    console.log('\n\n*****\n\n');

    scss = sass.renderSync({
      //outputStyle: 'compressed',
      data: scss
    });

    scss = scss.css.toString();
    return scss.replace(/____(*+?)____/g, function(match, $1) {

    });
  }
};

Reducer.parse = function(ast, opts) {
  var reducer = new Reducer(opts);
  reducer.reduceNode(ast);
  return reducer.templatize ? reducer.template(ast) : ast;
};

module.exports = Reducer;