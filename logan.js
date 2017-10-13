const LOG = false ? (output) => { console.log(output) } : () => { };

var logan = null;

Array.prototype.last = function() {
  if (!this.length) {
    return undefined;
  }
  return this[this.length - 1];
};

Array.prototype.remove = function(finder) {
  let index = this.findIndex(finder);
  if (index > -1) {
    this.splice(index, 1);
  }
};

Array.prototype.after = function(element, finder) {
  let index = this.findIndex(finder);
  if (index > -1) {
    this.splice(index + 1, 0, element);
  } else {
    this.push(element);
  }
};

Array.prototype.before = function(element, finder) {
  let index = this.findIndex(finder);
  if (index > -1) {
    this.splice(index, 0, element);
  } else {
    this.unshift(element);
  }
};

function ensure(array, itemName, def = {}) {
  if (!(itemName in array)) {
    array[itemName] = (typeof def === "function") ? def() : def;
  }

  return array[itemName];
}

function Bag(def) {
  for (let prop in def) {
    this[prop] = def[prop];
  }
}

Bag.prototype.on = function(prop, handler, elseHandler) {
  if (!this[prop]) {
    if (elseHandler) {
      elseHandler();
    }
    return;
  }
  let val = handler(this[prop], this);
  if (val) {
    return (this[prop] = val);
  }
  delete this[prop];
};

const GREP_REGEXP = new RegExp("((?:0x)?[A-Fa-f0-9]{4,})", "g");
const POINTER_REGEXP = /^(?:0x)?0*([0-9A-Fa-f]+)$/;
const NULLPTR_REGEXP = /^(?:(?:0x)?0+|\(null\)|\(nil\))$/;
const CAPTURED_LINE_LABEL = "a log line";

(function() {

  const FILE_SLICE = 5 * 1024 * 1024;
  const USE_RULES_TREE_OPTIMIZATION = true;

  const EPOCH_1970 = new Date("1970-01-01");

  let IF_RULE_INDEXER = 0;

  function isChildFile(file) {
    return file.name.match(/\.child-\d+(?:\.\d+)?$/);
  }

  function isRotateFile(file) {
    return file.name.match(/^(.*)\.\d+$/);
  }

  function rotateFileBaseName(file) {
    let baseName = isRotateFile(file);
    if (baseName) {
      return baseName[1];
    } 
    
    return file.name;
  }

  function escapeRegexp(s) {
    return s.replace(/\n$/, "").replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
  }

  const printfToRegexpMap = [
    // IMPORTANT!!!
    // Use \\\ to escape regexp special characters in the match regexp (left),
    // we escapeRegexp() the string prior to this conversion which adds
    // a '\' before each of such chars.
    [/%p/g, "((?:(?:0x)?[A-Fa-f0-9]+)|(?:\\(null\\))|(?:\\(nil\\)))"],
    [/%d/g, "(-?[\\d]+)"],
    [/%h?u/g, "([\\d]+)"],
    [/%s/g, "([^\\s]*)"],
    [/%\\\*s/g, "(.*)"],
    [/%\d*[xX]/g, "((?:0x)?[A-Fa-f0-9]+)"],
    [/%(?:\d+\\\.\d+)?f/g, "((?:[\\d]+)\.(?:[\\d]+))"],
    [/%\\\*\\\$/g, "(.*$)"]
  ];

  function convertPrintfToRegexp(printf) {
    if (RegExp.prototype.isPrototypeOf(printf)) {
      // already converted
      return printf;
    }

    printf = escapeRegexp(printf);

    for (let [source, target] of printfToRegexpMap) {
      printf = printf.replace(source, target);
    }

    return new RegExp('^' + printf + '$');
  }

  // Windows sometimes writes %p as upper-case-padded and sometimes as lower-case-unpadded
  // 000001500B043028 -> 1500b043000
  function pointerTrim(ptr) {
    if (!ptr) {
      return "0";
    }

    let pointer = ptr.match(POINTER_REGEXP);
    if (pointer) {
      return pointer[1].toLowerCase();
    }

    return ptr;
  }

  function ruleMappingGrade1(input) {
    let splitter = /(\W)/;
    let grade1 = input.split(splitter, 1)[0];
    if (!grade1 || grade1.match(/%/g)) {
      // grade1 contains a dynamic part or is empty, use the whole input as mapping
      // this is specially handled in module.set_rule
      return input;
    }
    return grade1;
  }

  function ruleMappingGrade2(input) {
    let grade1 = ruleMappingGrade1(input);
    let grade2 = input.substring(grade1.length);
    return { grade1, grade2 };
  }

  function Schema(namespace, lineRegexp, linePreparer) {
    this.namespace = namespace;
    this.lineRegexp = lineRegexp;
    this.linePreparer = linePreparer;
    this.modules = {};
    this.unmatch = [];
    this.ui = {
      summary: {}, // map: className -> prop to display on the summary line
    };

    this._finalize = function() {
      if (USE_RULES_TREE_OPTIMIZATION) {
        for (let module of Object.values(this.modules)) {
          for (let grade1 in module.rules_tree) {
            module.rules_tree[grade1] = Object.values(module.rules_tree[grade1]);
          }
        }
      }

      // This is grep() handler, has to be added as last because its condition handler
      // never returns true making following conditional rules process the line as well.
      this.plainIf(function(state) {
        for (let regexp of [GREP_REGEXP, this.nonPtrAliases]) {
          if (!regexp) {
            break;
          }
          let pointers = state.line.match(regexp);
          if (pointers) {
            if (pointers.length === 1 && state.line.trim() == pointers[0]) {
              // It doesn't make sense to include lines only containing the pointer.
              // TODO the condition here should be made even smarter to filter out
              // more of just useless lines.
              break;
            }
            for (let ptr of pointers) {
              let obj = state.objs[pointerTrim(ptr)];
              if (obj && obj._grep) {
                obj.capture();
              }
            }
          }
        }
      }.bind(this), () => { throw "grep() internal consumer should never be called"; });
    };

    this.update_alias_regexp = function() {
      let nonPtrAliases = [];
      for (let obj of Object.keys(logan._proc.objs)) {
        if (!obj.match(POINTER_REGEXP)) {
          nonPtrAliases.push(escapeRegexp(obj));
        }
      }
      this.nonPtrAliases = nonPtrAliases.length === 0 ? null : new RegExp("(" + nonPtrAliases.join("|") + ")", "g");
    };
  }


  Schema.prototype.module = function(name, builder) {
    builder(ensure(this.modules, name, new Module(name)));
  }

  Schema.prototype.plainIf = function(condition, consumer) {
    let rule = { cond: condition, consumer: consumer, id: ++IF_RULE_INDEXER };
    this.unmatch.push(rule);
    return rule;
  };

  Schema.prototype.ruleIf = function(exp, condition, consumer) {
    let rule = { regexp: convertPrintfToRegexp(exp), cond: condition, consumer: consumer, id: ++IF_RULE_INDEXER };
    this.unmatch.push(rule);
    return rule;
  };

  Schema.prototype.removeIf = function(rule) {
    this.unmatch.remove(item => item.id === rule.id);
  }

  Schema.prototype.summaryProps = function(className, arrayOfProps) {
    this.ui.summary[className] = arrayOfProps;
  };


  function Module(name) {
    this.name = name;
    this.rules_flat = [];
    this.rules_tree = {};

    this.set_rule = function(rule, input) {
      if (USE_RULES_TREE_OPTIMIZATION) {
        let mapping = ruleMappingGrade2(input);
        if (mapping.grade2) {
          let grade2 = ensure(this.rules_tree, mapping.grade1, {});
          grade2[mapping.grade2] = rule;
        } else {
          // all one-grade rules go alone, to allow dynamic parts to be at the begining of rules
          this.rules_flat.push(rule);
        }
      } else {
        this.rules_flat.push(rule);
      }
    };

    this.get_rules = function(input) {
      if (USE_RULES_TREE_OPTIMIZATION) {
        // logan.init() converts rules_tree to array.
        return (this.rules_tree[ruleMappingGrade1(input)] || []).concat(this.rules_flat);
      }
      return this.rules_flat;
    };
  }

  Module.prototype.rule = function(exp, consumer = function(ptr) { this.obj(ptr).capture(); }) {
    this.set_rule({ regexp: convertPrintfToRegexp(exp), cond: null, consumer: consumer }, exp);
  };


  function Obj(ptr) {
    this.id = logan.objects.length;
    // NOTE: when this list is enhanced, UI.summary has to be updated the "collect properties manually" section
    this.props = new Bag({ pointer: ptr, className: null, logid: this.id });
    this.captures = [];
    this.file = logan._proc.file;
    this.aliases = {};
    this._grep = false;
    this._dispatches = {};

    // This is used for placing the summary of the object (to generate
    // the unique ordered position, see UI.position.)
    // Otherwise there would be no other way than to use the first capture
    // that would lead to complicated duplications.
    this.placement = {
      time: logan._proc.timestamp,
      id: ++logan._proc.captureid,
    };

    logan.objects.push(this);
  }

  Obj.prototype.on = Bag.prototype.on;

  Obj.prototype.create = function(className, capture = true) {
    if (this.props.className) {
      console.warn(logan.exceptionParse("object already exists, recreting automatically from scratch"));
      this.destroy();
      return logan._proc.obj(this.__most_recent_accessor).create(className);
    }

    ensure(logan.searchProps, className, { pointer: true, state: true, logid: true });

    this.props.className = className;
    this.prop("state", "created");

    if (capture) {
      this.capture();
    }
    return this;
  };

  Obj.prototype.alias = function(alias) {
    if (logan._proc.objs[alias] === this) {
      return this;
    }

    if (alias.match(NULLPTR_REGEXP)) {
      return this;
    }

    alias = pointerTrim(alias);
    logan._proc.objs[alias] = this;
    this.aliases[alias] = true;

    if (!alias.match(POINTER_REGEXP)) {
      logan._schema.update_alias_regexp();
    }

    return this;
  };

  Obj.prototype.destroy = function(ifClassName) {
    if (ifClassName && this.props.className !== ifClassName) {
      return this;
    }

    delete logan._proc.objs[this.props.pointer];
    let updateAliasRegExp = false;
    for (let alias in this.aliases) {
      if (!alias.match(POINTER_REGEXP)) {
        updateAliasRegExp = true;
      }
      delete logan._proc.objs[alias];
    }
    this.prop("state", "released");
    delete this._references;

    if (updateAliasRegExp) {
      logan._schema.update_alias_regexp();
    }

    return this.capture();
  };

  function Capture(what) {
    this.id = ++logan._proc.captureid;
    this.time = logan._proc.timestamp;
    this.line = logan._proc.linenumber;
    this.thread = logan._proc.thread;
    this.what = what;

    logan._proc._captures[this.id] = this;
  }

  Obj.prototype.capture = function(what, info = null) {
    what = what || logan._proc.line;
    let capture = Capture.prototype.isPrototypeOf(what) ? what : new Capture(what);

    if (info) {
      info.capture = capture;
      info.source = this;
      info.index = this.captures.length;
    }

    this.captures.push(capture);
    return this;
  };

  Obj.prototype.grep = function() {
    this._grep = true;
    return this;
  };

  Obj.prototype.expect = function(format, consumer, error = () => true) {
    let match = convertPrintfToRegexp(format);
    let obj = this;
    let thread = logan._proc.thread;
    let rule = logan._schema.plainIf(proc => {
      if (proc.thread !== thread) {
        return false;
      }

      if (!logan.parse(proc.line, match, function() {
        return consumer.apply(this, [obj].concat(Array.from(arguments)).concat([this]));
      }, line => {
        return error(obj, line);
      })) {
        logan._schema.removeIf(rule);
      }
      return false;
    }, () => { throw "Obj.expect() handler should never be called"; });

    return this;
  };

  Obj.prototype.follow = function(cond, consumer, error = () => true) {
    let capture = {
      obj: this,
      module: logan._proc.module,
      thread: logan._proc.thread,
    };

    if (typeof cond === "number") {
      capture.count = cond;
      capture.follow = (obj, line, proc) => {
        obj.capture(line);
        return --capture.count;
      };
    } else if (typeof cond === "string") {
      capture.follow = (obj, line, proc) => {
        return logan.parse(line, cond, function() {
          return consumer.apply(this, [obj].concat(Array.from(arguments)).concat([this]));
        }, line => {
          return error(obj, line);
        });
      };
    } else if (typeof cond === "function") {
      capture.follow = cond;
    } else {
      throw logan.exceptionParse("follow() 'cond' argument unexpected type '" + typeof cond + "'");
    }

    logan._proc._pending_follow = capture;
    return this;
  }

  Obj.prototype.prop = function(name, value, merge = false) {
    ensure(logan.searchProps, this.props.className)[name] = true;

    if (typeof merge === "funtion") {
      merge = merge(this);
    }

    if (value === undefined) {
      delete this.props[name];
    } else if (typeof value === "function") {
      this.props[name] = value(this.props[name] || 0);
    } else if (merge && this.props[name]) {
      this.props[name] += ("," + value);
    } else {
      this.props[name] = value;
    }
    return this.capture({ prop: name, value: this.props[name] });
  };

  Obj.prototype.propIf = function(name, value, cond, merge) {
    if (!cond(this)) {
      return this;
    }
    return this.prop(name, value, merge);
  };

  Obj.prototype.propIfNull = function(name, value) {
    if (name in this.props) {
      return this;
    }
    return this.prop(name, value);
  };

  Obj.prototype.state = function(state, merge = false) {
    if (!state) {
      return this.props["state"];
    }
    return this.prop("state", state, merge);
  };

  Obj.prototype.stateIf = function(state, cond, merge = false) {
    if (!cond(this)) {
      return this;
    }
    return this.prop("state", state, merge);
  };

  Obj.prototype.link = function(that) {
    that = logan._proc.obj(that);
    let capture = new Capture({ linkFrom: this, linkTo: that });
    this.capture(capture);
    that.capture(capture);
    return this;
  };

  Obj.prototype.mention = function(that) {
    if (typeof that === "string" && that.match(NULLPTR_REGEXP)) {
      return this;
    }
    that = logan._proc.obj(that);
    this.capture({ expose: that });
    return this;
  };

  Obj.prototype.class = function(className) {
    if (this.props.className) {
      // Already created
      return this;
    }
    return this.create(className, false).state("partial").prop("missing-constructor", true);
  };

  Obj.prototype.dispatch = function(target, name) {
    if (name === undefined) {
      target = this;
      name = target;
    }

    target = logan._proc.obj(target);

    let dispatch = {};
    this.capture({ dispatch: true }, dispatch);

    ensure(target._dispatches, name, []).push(dispatch);
    return this;
  },

  Obj.prototype.run = function(name) {
    let origin = this._dispatches[name];
    if (!origin) {
      return this;
    }

    let dispatch = origin.shift();
    if (!origin.length) {
      delete this._dispatches[name];
    }
    return this.capture({ run: dispatch }); // dispatch = { capture, source, index }
  },

  Obj.prototype.ipcid = function(id) {
    if (id === undefined) {
      return this.ipc_id;
    }
    this.ipc_id = id;
    return this.prop("ipc-id", id);
  },

  Obj.prototype.send = function(message) {
    if (!logan._proc._ipc) {
      return this;
    }
    if (this.ipc_id === undefined) {
      return this;
    }

    let create = () => {
      let origin = {};
      this.capture({ dispatch: true }, origin);
      LOG(" storing send() " + logan._proc.line + " ipcid=" + this.ipc_id);
      return {
        sender: this,
        origin: origin
      };
    };

    let id = message + "::" + this.ipc_id;
    let sync = logan._proc._sync[id];

    if (!sync) {
      logan._proc._sync[id] = create();
      return this;
    }

    if (sync.sender) {
      while (sync.next) {
        sync = sync.next;
      }
      sync.next = create();
      return this;
    }

    delete logan._proc._sync[id];

    LOG(" send() calling on stored recv() " + logan._proc.line + " ipcid=" + this.ipc_id);

    let proc = logan._proc.swap(sync.proc);
    logan._proc.file.__recv_wait = false;
    sync.func(sync.receiver, this);
    logan._proc.restore(proc);

    return this;
  },

  Obj.prototype.recv = function(message, func = () => {}) {
    if (!logan._proc._ipc) {
      return this;
    }

    if (this.ipc_id === undefined) {
      return this;
    }

    let id = message + "::" + this.ipc_id;

    let sync = logan._proc._sync[id];
    if (!sync) {
      // There was no send() call for this ipcid and message, hence
      // we have to wait.  Store the recv() info and proccessing state
      // and stop parsing this file.
      logan._proc._sync[id] = {
        func: func,
        receiver: this,
        proc: logan._proc.save(),
      };

      logan._proc.file.__recv_wait = true;

      LOG(" blocking and storing recv() " + logan._proc.line + " ipcid=" + this.ipc_id + " file=" + logan._proc.file.name);
      return this;
    }

    if (sync.next) {
      logan._proc._sync[id] = sync.next;
    } else {
      delete logan._proc._sync[id];
    }

    LOG(" recv() taking stored send() " + logan._proc.line + " ipcid=" + this.ipc_id);

    this.capture({ run: sync.origin });
    func(this, sync.sender);

    return this;
  },


  // export
  logan = {
    // processing state sub-object, passed to rule consumers
    _proc: {
      _obj: function(ptr, store) {
        if (Obj.prototype.isPrototypeOf(ptr)) {
          return ptr;
        }

        ptr = pointerTrim(ptr);
        if (ptr === "0") {
          store = false;
        }

        let obj = this.objs[ptr];
        if (!obj) {
          obj = new Obj(ptr);
          if (store) {
            this.objs[ptr] = obj;
            if (!ptr.match(POINTER_REGEXP)) {
              logan._schema.update_alias_regexp();
            }
          }
        }

        obj.__most_recent_accessor = ptr;
        return obj;
      },

      objIf: function(ptr) {
        return this._obj(ptr, false);
      },

      obj: function(ptr) {
        return this._obj(ptr, true);
      },

      duration: function(timestamp) {
        if (!timestamp) {
          return undefined;
        }
        return this.timestamp.getTime() - timestamp.getTime();
      },

      // private

      save: function() {
        return ["timestamp", "thread", "line", "file", "module", "raw"].reduce(
          (result, prop) => (result[prop] = this[prop], result), {});
      },

      restore: function(from) {
        for (let property in from) {
          this[property] = from[property];
        }
      },

      swap: function(through) {
        let result = this.save();
        this.restore(through);
        return result;
      }
    },

    _schemes: {},
    _schema: null,

    schema: function(name, lineRegexp, linePreparer, builder) {
      this._schema = ensure(this._schemes, name, () => new Schema(name, lineRegexp, linePreparer));
      builder(this._schema);
    },

    activeSchema: function(name) {
      this._schema = this._schemes[name];
    },

    parse: function(line, printf, consumer, unmatch) {
      let result;
      if (!this.processRule(line, convertPrintfToRegexp(printf), function() {
        result = consumer.apply(this, arguments);
      })) {
        return (unmatch && unmatch.call(this._proc, line));
      }
      return result;
    },


    // The rest is considered private

    exceptionParse: function(exception) {
      if (typeof exception === "object") {
        exception = "'" + exception.message + "' at " + exception.fileName + ":" + exception.lineNumber
      }
      exception += "\nwhile processing '" + this._proc.raw +
                   "'\nat " + this._proc.file.name + ":" + this._proc.linenumber + " (line#s are inaccurate)";
      return new Error(exception);
    },

    files: [],

    init: function() {
      for (let schema of Object.values(this._schemes)) {
        schema._finalize();
      }
    },

    initProc: function(UI) {
      this.objects = [];
      this.searchProps = {};
      this._proc.global = {};
      this._proc.captureid = 0;
      this._proc._captures = [];
      this._proc._sync = {};

      let parents = {};
      let children = {};
      let update = (array, item) => {
        return (array[item] = array[item] ? (array[item] + 1) : 1);
      };

      for (let file of this.files) {
        file.__base_name = rotateFileBaseName(file);
        if (isChildFile(file)) {
          file.__is_child = true;
          file.__base_order = update(children, file.__base_name);
        } else {
          file.__base_order = update(parents, file.__base_name);
        }
      }

      parents = Object.keys(parents).length;
      children = Object.keys(children).length;

      if (parents > 1) {
        UI.warn("More than one parent log - is that what you want?");
      }
      if (parents == 0 && children > 1) {
        UI.warn("Loading orphan child logs - is that what you want?");
      }

      this._proc._ipc = parents == 1 && children > 0;
      this._proc.threads = {};
      this._proc.objs = {};

      netdiag.reset();
    },

    consumeURL: function(UI, url) {
      this.seekId = 0;
      this.initProc();

      fetch(url).then(function(response) {
        return response.blob();
      }).then(function(blob) {
        blob.name = "_net_"
        this.consumeFiles(UI, [blob]);
      }.bind(this));
    },

    consumeFiles: function(UI, files) {
      UI.searchingEnabled(false);

      this.files = Array.from(files);
      this.seekId = 0;
      this.initProc();

      UI.resetProgress();

      files = [];
      for (let file of this.files) {
        if (!file.__is_child) {
          UI.title(file.__base_name);
        }
        files.push(this.readFile(UI, file));
      }

      Promise.all(files).then((files) => {
        this.consumeParallel(UI, files);
      });
    },

    readFile: function(UI, file) {
      UI.addToMaxProgress(file.size);

      file.__line_number = 0;

      let previousLine = "";
      let slice = (segment) => {
        return new Promise((resolve, reject) => {
          let blob = file.slice(segment * FILE_SLICE, (segment + 1) * FILE_SLICE);
          if (blob.size == 0) {
            resolve({
              file: file,
              lines: [previousLine]
            });
            return;
          }

          let reader = new FileReader();
          reader.onloadend = (event) => {
            if (event.target.readyState == FileReader.DONE && event.target.result) {
              UI.addToLoadProgress(blob.size);

              let lines = event.target.result.split(/[\r\n]+/);

              // This simple code assumes that a single line can't be longer than FILE_SLICE
              lines[0] = previousLine + lines[0];
              previousLine = lines.pop();

              resolve({
                file: file,
                lines: lines,
                read_more: () => slice(segment + 1)
              });
            }
          };

          reader.onerror = (event) => {
            console.error(`Error while reading segment ${segment} of ${file.name}`);
            console.exception(reader.error);
            window.onerror(reader.error);

            reader.abort();
            reject(reader.error);
          };

          reader.readAsBinaryString(blob);
        });
      };

      return slice(0);
    },

    consumeParallel: async function(UI, files) {
      while (files.length) {
        // Make sure that the first line on each of the files is prepared
        // Preparation means to determine timestamp, thread name, module, if found,
        // or derived from the last prepared line
        for (let file of Array.from(files)) {
          if (file.prepared) {
            continue;
          }

          if (!file.lines.length) {
            files.remove((item) => file === item);

            if (!file.read_more) {
              continue;
            }

            file = await file.read_more();
            files.push(file);
          }

          file.prepared = this.prepareLine(file.lines.shift(), file.previous);
          file.file.__line_number++;
        }

        if (!files.length) {
          break;
        }

        // Make sure the file with the earliest timestamp line is the first,
        // we then consume files[0].
        files.sort((a, b) => {
          return a.prepared.timestamp.getTime() - b.prepared.timestamp.getTime() ||
                 a.file.__base_order - b.file.__base_order; // overlapping of timestamp in rotated files
        });

        let consume = files.find(file => !file.file.__recv_wait);
        if (!consume) {
          // All files are blocked probably because of large timestamp shift
          // Let's just unblock parsing, in most cases we will satisfy recv()
          // soon after.
          consume = files[0];
        }

        this.consumeLine(UI, consume.file, consume.prepared);
        consume.previous = consume.prepared;
        delete consume.prepared;
      }

      this.processEOS(UI);
    },

    prepareLine: function(line, previous) {
      previous = previous || {};

      let match = line.match(this._schema.lineRegexp);
      if (!match) {
        previous.module = 0;
        previous.raw = line;
        previous.text = line;
        previous.timestamp = previous.timestamp || EPOCH_1970;
        return previous;
      }

      previous = this._schema.linePreparer.apply(null, match);
      previous.raw = line;
      return previous;
    },

    consumeLine: function(UI, file, prepared) {
      if (this.consumeLineByRules(UI, file, prepared)) {
        return;
      }

      let follow = this._proc.thread._engaged_follows[prepared.module];
      if (follow && !follow.follow(follow.obj, prepared.text, this._proc)) {
        delete this._proc.thread._engaged_follows[prepared.module];
      }
    },

    consumeLineByRules: function(UI, file, prepared) {
      this._proc.file = file;
      this._proc.timestamp = prepared.timestamp;
      this._proc.line = prepared.text;
      this._proc.raw = prepared.raw;
      this._proc.module = prepared.module;
      this._proc.linenumber = file.__line_number;
      this._proc.thread = ensure(this._proc.threads,
        file.__base_name + "|" + prepared.threadname,
        () => new Bag({ name: prepared.threadname, _engaged_follows: {} }));

      let module = this._schema.modules[prepared.module];
      if (module && this.processLine(module.get_rules(prepared.text), file, prepared)) {
        return true;
      }
      if (this.processLine(this._schema.unmatch, file, prepared)) {
        return true;
      }

      return false;
    },

    processLine: function(rules, file, prepared) {
      this._proc._pending_follow = null;

      if (this.processLineByRules(rules, file, prepared.text)) {
        if (this._proc._pending_follow) {
          // a rule matched and called follow(), make sure the right thread is set
          // this follow.
          let module = this._proc._pending_follow.module;
          this._proc._pending_follow.thread._engaged_follows[module] = this._proc._pending_follow;
          // for lines w/o a module use the most recent follow
          this._proc._pending_follow.thread._engaged_follows[0] = this._proc._pending_follow;
        } else {
          // a rule on the module where the last follow() has been setup has
          // matched, what is the signal to remove that follow.
          delete this._proc.thread._engaged_follows[prepared.module];
          delete this._proc.thread._engaged_follows[0];
        }
        return true;
      }

      return false;
    },

    processLineByRules: function(rules, file, line) {
      this._proc.line = line;
      let conditionResult;
      for (let rule of rules) {
        try {
          if (rule.cond) {
            conditionResult = rule.cond(this._proc);
            if (!conditionResult) {
              continue;
            }
          }
        } catch (exception) {
          throw this.exceptionParse(exception);
        }

        if (!rule.regexp) {
          if (!rule.cond) {
            throw this.exceptionParse("INTERNAL ERROR: No regexp and no cond on a rule");
          }

          try {
            rule.consumer.call(this._proc, line, conditionResult);
          } catch (exception) {
            throw this.exceptionParse(exception);
          }
          return true;
        }

        if (!this.processRule(line, rule.regexp, function() {
              rule.consumer.apply(this, Array.from(arguments).concat(conditionResult));
            })) {
          continue;
        }
        return true;
      }

      return false;
    },

    processRule: function(line, regexp, consumer) {
      let match = line.match(regexp);
      if (!match) {
        return false;
      }

      try {
        consumer.apply(this._proc, match.slice(1));
      } catch (exception) {
        throw this.exceptionParse(exception);
      }
      return true;
    },

    processEOS: function(UI) {
      for (let sync_id in this._proc._sync) {
        let sync = this._proc._sync[sync_id];
        if (sync.receiver) {
          UI.warn("Missing some IPC synchronization points fulfillment, check web console");
          console.log(`file ${sync.proc.file.name} '${sync.proc.raw}', never received '${sync_id}'`);
        }
      }

      UI.loadProgress(0);
      UI.fillClassNames(this.searchProps);
      UI.fillSearchBy();
      UI.searchingEnabled(true);
    },

    search: function(UI, className, propName, matchValue, match, seekId, coloring) {
      var matchFunc;
      propToString = (prop) => (prop === undefined ? "" : prop.toString());
      switch (match) {
        case "==": {
          if (propName === "pointer") {
            matchFunc = prop => pointerTrim(matchValue) == prop;
          } else {
            matchFunc = prop => matchValue == propToString(prop);
          }
          break;
        }
        case "!!": {
          matchFunc = prop => prop !== undefined;
          break;
        }
        case "!": {
          matchFunc = prop => prop === undefined;
          break;
        }
        case ">": {
          matchFunc = prop => prop > matchValue;
          break;
        }
        case "<": {
          matchFunc = prop => prop < matchValue;
          break;
        }
        case "contains": {
          let contains = new RegExp(escapeRegexp(matchValue), "g");
          matchFunc = prop => propToString(prop).match(contains);
          break;
        }
        case "!contains": {
          let ncontains = new RegExp(escapeRegexp(matchValue), "g");
          matchFunc = prop => !propToString(prop).match(ncontains);
          break;
        }
        case "rx": {
          let regexp = new RegExp(matchValue, "g");
          matchFunc = prop => propToString(prop).match(regexp);
          break;
        }
        case "!rx": {
          let nregexp = new RegExp(matchValue, "g");
          matchFunc = prop => !propToString(prop).match(nregexp);
          break;
        }
        default:
          throw "Unexpected match operator";
      }

      for (let obj of this.objects) {
        if (className !== '*' && className != obj.props.className) {
          continue;
        }
        if (seekId && obj.captures[0].id > seekId) {
          continue;
        }

        if (propName === CAPTURED_LINE_LABEL) {
          if (!obj.captures.find(capture => {
            if (seekId && capture.id > seekId) {
              return false;
            }
            return typeof capture.what === "string" && matchFunc(capture.what);
          })) {
            continue;
          }
        } else {
          if (seekId && obj.captures.last().id >= seekId) {
            // The object lives around the cutting point, find the prop value
            var prop = "";
            let capture = obj.captures.find(capture => {
              if (capture.id > seekId) {
                return true;
              }
              if (typeof capture.what === "object" && capture.what.prop == propName) {
                prop = capture.what.value;
              }
              return false;
            }, this);
          } else {
            var prop = obj.props[propName];
          }
          if (!matchFunc(prop)) {
            continue;
          }
        }
        UI.addResult(obj).addClass("result").css("color", coloring);
      }
    },
  }; // logan impl

})();
