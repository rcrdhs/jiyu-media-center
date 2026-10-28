/* Samsung TV polyfills for the 2020-2022 Chromium (69-85). ES5, loaded before
 * the app bundle by tizen/index.html. Syntax is already lowered by Vite
 * (build --mode tizen, target chrome69); this fills runtime APIs only. */
(function () {
  function def(obj, name, fn) {
    if (obj && !obj[name]) {
      try {
        Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true })
      } catch (e) {
        obj[name] = fn
      }
    }
  }
  if (typeof globalThis === 'undefined') {
    try {
      Object.defineProperty(Object.prototype, '__jiyuGlobal', {
        get: function () {
          return this
        },
        configurable: true,
      })
      /* eslint-disable-next-line no-undef */
      __jiyuGlobal.globalThis = __jiyuGlobal
      delete Object.prototype.__jiyuGlobal
    } catch (e) {
      window.globalThis = window
    }
  }
  def(Object, 'fromEntries', function (iter) {
    var out = {}
    Array.from(iter).forEach(function (pair) {
      out[pair[0]] = pair[1]
    })
    return out
  })
  def(Object, 'hasOwn', function (o, k) {
    return Object.prototype.hasOwnProperty.call(o, k)
  })
  function at(n) {
    n = Math.trunc(n) || 0
    if (n < 0) n += this.length
    if (n < 0 || n >= this.length) return undefined
    return this[n]
  }
  def(Array.prototype, 'at', at)
  def(String.prototype, 'at', at)
  def(Array.prototype, 'flat', function (depth) {
    depth = depth === undefined ? 1 : Number(depth)
    var src = this
    return depth < 1
      ? Array.prototype.slice.call(src)
      : Array.prototype.reduce.call(
          src,
          function (acc, v) {
            return acc.concat(Array.isArray(v) ? v.flat(depth - 1) : [v])
          },
          [],
        )
  })
  def(Array.prototype, 'flatMap', function (fn, thisArg) {
    return Array.prototype.map.call(this, fn, thisArg).flat(1)
  })
  def(Array.prototype, 'findLast', function (fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i]
    return undefined
  })
  def(Array.prototype, 'findLastIndex', function (fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i
    return -1
  })
  def(Array.prototype, 'toSorted', function (cmp) {
    return Array.prototype.slice.call(this).sort(cmp)
  })
  def(Array.prototype, 'toReversed', function () {
    return Array.prototype.slice.call(this).reverse()
  })
  def(String.prototype, 'replaceAll', function (search, repl) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError('replaceAll needs a global RegExp')
      return this.replace(search, repl)
    }
    return this.split(String(search)).join(
      typeof repl === 'function' ? repl(String(search)) : String(repl),
    )
  })
  def(String.prototype, 'trimStart', String.prototype.trimLeft)
  def(String.prototype, 'trimEnd', String.prototype.trimRight)
  def(Promise, 'allSettled', function (list) {
    return Promise.all(
      Array.from(list).map(function (p) {
        return Promise.resolve(p).then(
          function (value) {
            return { status: 'fulfilled', value: value }
          },
          function (reason) {
            return { status: 'rejected', reason: reason }
          },
        )
      }),
    )
  })
  def(Promise, 'any', function (list) {
    return new Promise(function (resolve, reject) {
      var arr = Array.from(list)
      var left = arr.length
      var errors = []
      if (!left) reject(new Error('All promises were rejected'))
      arr.forEach(function (p, i) {
        Promise.resolve(p).then(resolve, function (e) {
          errors[i] = e
          if (--left === 0) {
            var err = new Error('All promises were rejected')
            err.errors = errors
            reject(err)
          }
        })
      })
    })
  })
  def(window, 'queueMicrotask', function (fn) {
    Promise.resolve().then(fn)
  })
  def(window, 'structuredClone', function (v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
  })
  if (window.AbortSignal) {
    def(AbortSignal, 'timeout', function (ms) {
      var c = new AbortController()
      setTimeout(function () {
        c.abort()
      }, ms)
      return c.signal
    })
  }
  def(window, 'requestIdleCallback', function (fn) {
    return setTimeout(function () {
      fn({ didTimeout: false, timeRemaining: function () { return 15 } })
    }, 1)
  })
  def(window, 'cancelIdleCallback', function (id) {
    clearTimeout(id)
  })
})()
