const { Transform } = require("stream");

function IteratorWrapper(iterator, prefix, options = {}) {
  const proxy = new Proxy(iterator, {
    get(target, property) {
      switch (property) {
        case "next": {
          return (...args) => {
            const [callback] = args;

            args[0] = (error, key, value) => {
              if (key) {
                const decoded = options.decodeKey(key);

                if (decoded[0] === prefix) {
                  callback(error, decoded[1], value);
                }
              } else {
                callback(error, key, value);
              }
            };

            target[property].apply(target, args);

            return proxy;
          };
        }

        case "seek": {
          return (...args) => {
            args[0] = options.encodeKey([prefix, args[0]]);
            target[property].apply(target, args);
            return proxy;
          };
        }

        default: {
          return target[property];
        }
      }
    },
  });

  return proxy;
}

function BatchWrapper(batch, prefix = [], options = {}) {
  const proxy = new Proxy(batch, {
    get(target, property) {
      switch (property) {
        case "clear": {
          return (...args) => {
            target[property].apply(target, args);
            return proxy;
          };
        }

        case "del":
        case "put": {
          return (...args) => {
            args[0] = options.encodeKey([prefix, args[0]]);
            target[property].apply(target, args);
            return proxy;
          };
        }

        default: {
          return target[property];
        }
      }
    },
  });

  return proxy;
}

function Wrapper(db, prefix, options = {}) {
  options.encodeKey = options.encodeKey || (p => p.map(encodeURIComponent).join("@"));
  options.decodeKey = options.decodeKey || (s => s.split("@").map(decodeURIComponent));

  const proxy = new Proxy(db, {
    get(target, property) {
      switch (property) {
        case "prefix": {
          return prefix;
        }

        case "select": {
          return prefix => {
            return new Wrapper(db, prefix, options);
          };
        }

        case "del":
        case "get":
        case "put": {
          return (...args) => {
            args[0] = options.encodeKey([prefix, args[0]]);
            return target[property].apply(target, args);
          };
        }

        case "batch": {
          return (...args) => {
            if (args.length > 0) {
              args[0] = args[0].map(op => ({ ...op, key: options.encodeKey([prefix, op.key]) }));
              return target[property].apply(target, args);
            }

            return new BatchWrapper(target[property].apply(target, args), prefix, options);
          };
        }

        case "createKeyStream":
        case "createReadStream":
        case "createValueStream": {
          const stream = new Transform({
            objectMode: true,
            transform: (data, encoding, callback) => {
              if (property === "createKeyStream") {
                return callback(null, options.decodeKey(data)[1]);
              }

              if (property === "createReadStream") {
                return callback(null, {
                  key: options.decodeKey(data.key)[1],
                  value: data.value,
                });
              }

              return callback(null, data);
            },
          });

          return (...args) => {
            if (args.length > 0) {
              for (const property of ["gt", "gte", "lt", "lte"]) {
                if (property in args[0]) {
                  args[0][property] = options.encodeKey([prefix, args[0][property]]);
                }
              }
            } else {
              args.push({
                gte: options.encodeKey([prefix, "\u0000"]),
                lte: options.encodeKey([prefix, "\uffff"]),
              });
            }

            return target[property].apply(target, args).pipe(stream);
          };
        }

        case "iterator": {
          return (...args) => {
            if (typeof args[0] === "object") {
              for (const property of ["gt", "gte", "lt", "lte"]) {
                if (property in args[0]) {
                  args[0][property] = options.encodeKey([prefix, args[0][property]]);
                }
              }
            }

            return new IteratorWrapper(target[property].apply(target, args), prefix, options);
          };
        }

        default: {
          return target[property];
        }
      }
    },
  });

  return proxy;
}

module.exports = (db, options = {}) => {
  return new Wrapper(db, null, options);
};
