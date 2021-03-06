declare var global: any
import chalk from 'chalk'
import { Request } from 'express'
const { RateLimiter } = require('limiter')
const atob = require('atob')
const getIP = require('../lib/getIP.js')
const uuidv4 = require('uuid/v4')
const WebSocket = require('ws')
const pako = require('pako')

import Logger from '../logger'
import { Database } from '../database/definitions/database'
import { SocketSession } from './definitions/session'

import ClientInfo from './ClientInfo'
import InjectAPI from './InjectAPI'
import { Transforms } from './Transforms'

export default class {
  db: any
  server: any

  constructor(db: any, server: any) {
    this.db = db
    this.server = server
  }

  initiate(ws: any, req: any) {
    this.validate(req)
      .then((project) => {
        new Session(ws, req, project)
      })
      .catch((error: string | Error) => {
        Logger(['websockets', 'initiate'], 'error', error)
      })
  }

  validate(req: Request) {
    return new Promise<SocketSession.session>((resolve, reject) => {
      let url = req.url.split('?')
      if (url) {
        let state = {
          project: url[url.length - 1],
          version: +url[0].substr(2) || 0,
          debug: false
        }
        if (state.project.charAt(0) === '$') {
          state = {
            ...state,
            project: state.project.substring(1),
            debug: true
          }
        }
        if (state.project) {
          try {
            state.project = atob(state.project)
          } catch (e) {
            reject(
              'websocket with invalid base64 encoded project name, terminating'
            )
            return
          }
          this.db.collection('projects', (err, projects) => {
            if (err) throw err
            projects
              .findOne({
                name: state.project
              })
              .then((doc: Database.project) => {
                if (doc !== null) {
                  resolve({
                    project: {
                      id: doc['_id'],
                      name: doc.name,
                      config: doc.config
                    },
                    id: uuidv4(),
                    version: state.version,
                    debug: state.debug
                  })
                } else {
                  reject(
                    `websocket connection to nonexistent project "${
                      state.project
                    }", terminating`
                  )
                }
              })
          })
        } else {
          reject('websocket connection with invalid project name, terminating')
        }
      } else {
        reject('websocket connection with missing project name, terminating')
      }
    })
  }
}

class Session {
  socket: any
  session: SocketSession.session
  project: SocketSession.project
  token: string
  req: Request
  authReq: Request
  client: any
  cached = false
  core: { bundle: string; hash: string }

  constructor(socket: any, req: any, session: SocketSession.session) {
    socket.id = uuidv4()
    req.id = socket.id
    this.socket = socket
    this.req = req
    this.session = session
    this.project = session.project
    /**
     * Select the correct Core
     */
    this.core = this.session.debug
      ? global.inject.core.development
      : global.inject.core.production
    /**
     * Give the client time to connect, or else they may be droppped
     */
    setTimeout(() => {
      this.auth(socket.id)
    }, 100)
  }

  send(topic: string, data: any) {
    /**
     * Enhanced transport
     */
    const json = JSON.stringify(data)
    let transport = `${topic}${json ? ':' + json : ''}`
    if (
      global.config.compression &&
      !this.session.debug &&
      !/^core|auth$/.test(topic)
    ) {
      transport =
        '#' +
        pako.deflate(transport, {
          to: 'string'
        })
    }
    try {
      /**
       * Basic RAW transport
       */
      if (/^core|auth$/.test(topic)) {
        if (this.session.version === 0) {
          /**
           * Payload version 0
           */
          transport = JSON.stringify({
            d: data
          })
        } else {
          /**
           * Payload version 1
           */
          transport = data
        }
      }
      this.socket.send(transport)
    } catch (error) {
      if (this.socket.readyState !== WebSocket.OPEN) this.socket.close()
    }
  }

  auth(id: string) {
    this.send('auth', Transforms.auth(id, this.core.hash))
    global.inject.authenticate[id] = (token: string, req) =>
      this.authorized(token, req)
  }

  authorized(token: string, req) {
    this.token = token
    this.authReq = req
    let injectAPI
    let limiter = new RateLimiter(
      global.config.rateLimiting.inject.websocket.max,
      global.config.rateLimiting.inject.websocket.windowMs,
      true
    )
    let limiterLimiter = new RateLimiter(50, 15000, true)

    this.socket.on('message', (raw: string) => {
      let { tokens } = global.config.rateLimiting.inject
      let token = 1
      let topic: string
      let vow: string
      let data: any
      try {
        /**
         * Compression
         */
        if (raw.charAt(0) === '#') {
          if (global.config.compression) {
            try {
              raw = pako.inflate(raw.substr(1), { to: 'string' })
            } catch (e) {
              if (global.config.debug) {
                Logger(['websockets', 'compression'], 'warn', {
                  why: 'error',
                  ip: this.client.client.ip.query
                })
              }
              return
            }
          } else {
            Logger(['websockets', 'compression'], 'warn', {
              why: 'disabled',
              ip: this.client.client.ip.query
            })
            return
          }
        }
        try {
          // Topic parser
          const separator = raw.indexOf(':')
          if (separator > -1) {
            topic = raw.substring(0, separator)
            data = JSON.parse(raw.substring(separator + 1))
          } else {
            topic = raw
          }

          // Vow proxy
          if (
            topic === 'v' &&
            data instanceof Array &&
            typeof data[0] === 'string' &&
            typeof data[1] === 'string'
          ) {
            vow = data[1]
            topic = data[0]
            data = data[2]
          }
        } catch (e) {
          Logger(['websockets', 'parse'], 'warn', {
            ip: this.client.client.ip.query
          })
          return
        }
      } catch (error) {
        Logger(['websockets', 'message'], 'error', {
          ip: this.client.client.ip.query,
          error: error.stack
        })
        return
      }
      if (tokens) {
        switch (topic) {
          case 'p':
            if (typeof tokens.pageGhost === 'number') token = tokens.pageGhost
            break
          case 'l' || 'e':
            if (typeof tokens.logger === 'number') token = tokens.logger
            break
          case 'module':
            if (typeof tokens.modules === 'number') token = tokens.modules
            break
          case 'i':
            if (typeof tokens.clientInfo === 'number') token = tokens.clientInfo
            break
        }
      }
      limiter.removeTokens(token, (err, remainingRequests) => {
        if (!(err || remainingRequests < 1)) {
          if (injectAPI.on[topic]) injectAPI.on[topic](data, {
            resolve: (data) => {
              if (!vow) return
              this.send('v', ['resolve', vow, data])
            },
            reject: (data) => {
              if (!vow) return
              this.send('v', ['reject', vow, data])
            }
          })
        } else {
          // Don't send any warnings for events that are bound to go over the limit often
          if (/^p|heartbeat$/.test(topic)) return
          // Rate limit error messages, stopping the client from being flooded
          limiterLimiter.removeTokens(1, (error, remaining) => {
            if (!(error || remaining < 1)) {
              this.send('rate-limiter', {
                topic: topic,
                data: data
              })
            }
          })
        }
      })
    })
    this.socket.on('close', () => this.close())
    this.socket.on('error', () => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        this.socket.close()
      }
    })

    /**
     * Add the session to the global sessions object
     */
    this.ledge(({ client, session }) => {
      /**
       * Log to console
       */
      Logger(['websockets', 'connect'], 'log', {
        project: this.project.name,
        debug: session.debug,
        ip: client.ip.query,
        url: session.window.url
      })

      /**
       * Set the client object
       */
      this.client = {
        client,
        session
      }
      /**
       * Enable access to the inject API
       */
      injectAPI = new InjectAPI(this)
      /**
       * Callback to the Injectify users
       */
      if (global.inject.watchers[this.project.id]) {
        setTimeout(() => {
          global.inject.watchers[this.project.id].forEach((watcher) => {
            watcher.callback('connect', {
              token: this.token,
              data: global.inject.clients[this.project.id][this.token]
            })
          })
        }, 0)
      }

      /**
       * Client side variables
       */
      const variables = {
        __client: {
          ip: client.ip,
          id: session.id,
          'user-agent': client.agent,
          headers: {
            ...this.req.headers,
            'user-agent': undefined
          },
          platform: client.platform,
          os: client.os
        },
        __server: {
          compression: this.session.debug ? false : !!global.config.compression,
          version: this.core.hash,
          cached: false
        }
      }

      /**
       * Deliver the Injectify Core
       */
      if (this.authReq.query.t === '1') {
        /**
         * Client has the current version of the Core cached
         */
        variables.__server.cached = true
        this.send(
          'core',
          Transforms.cache(
            variables,
            this.session.debug,
            this.session.project.config.autoexecute
          )
        )
      } else {
        /**
         * Core loader
         */
        this.send(
          'core',
          Transforms.core(
            this.core,
            variables,
            this.session.debug,
            this.session.project.config.autoexecute
          )
        )
      }
    })
  }

  ledge(resolve: Function) {
    /**
     * Create an object for the project
     */
    if (!global.inject.clients[this.project.id]) {
      global.inject.clients[this.project.id] = {}
    }

    ClientInfo(this.req, this.authReq, this.session).then(
      ({ client, session }) => {
        /**
         * Create an object for the client
         */
        if (!global.inject.clients[this.project.id][this.token]) {
          global.inject.clients[this.project.id][this.token] = client
        }
        /**
         * Add a reference to the send method
         */
        session.execute = (script) => {
          this.send('execute', script)
        }
        /**
         * Add a reference to the send method
         */
        session.scroll = (array) => {
          this.send('scroll', array)
        }
        global.inject.clients[this.project.id][this.token].sessions.push(
          session
        )

        resolve({
          client: client,
          session: session
        })
      }
    )
  }

  close() {
    /**
     * => NOTE: this line *may* cause trouble down the line \/
     */
    if (
      global.inject.clients[this.project.id] &&
      global.inject.clients[this.project.id][this.token] &&
      global.inject.clients[this.project.id][this.token].sessions
    ) {
      /**
       * Remove them from the clients object
       */
      if (
        global.inject.clients[this.project.id][this.token].sessions.length === 1
      ) {
        /**
         * Only session left with their token, delete token
         */
        delete global.inject.clients[this.project.id][this.token]
      } else {
        /**
         * Other sessions exist with their token
         */
        global.inject.clients[this.project.id][
          this.token
        ].sessions = global.inject.clients[this.project.id][
          this.token
        ].sessions.filter((session) => session.id !== this.session.id)
      }
      /**
       * Callback to the Injectify users
       */
      if (global.inject.watchers[this.project.id]) {
        setTimeout(() => {
          global.inject.watchers[this.project.id].forEach((watcher) => {
            watcher.callback('disconnect', {
              token: this.token,
              id: this.session.id
            })
          })
        }, 0)
      }
    }
  }
}
