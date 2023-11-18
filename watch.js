'use strict'
var
  chalk       = require('chalk'),
  chalkStyles = require('ansi-styles'),
  hasColor    = require('has-ansi'),
  stripColor  = require('strip-ansi'),
  chokidar    = require('chokidar'),
  dwServer    = require('dw-webdav'),
  path        = require('path'),
  sliceAnsi   = require('slice-ansi'),
  utils       = require('./utils')

function watch(config){


  var host       = config.hostname
  var version    = config.version
  var username   = config.username
  var cartridges = config.cartridges
  var password   = config.password
  var ignore     = config.ignore


  var server = new dwServer(host, 'dw-utils', username, password)

  let tries = 0;
  function authError(e){
    if (e == 'EXIT') return Promise.reject('EXIT');

    if (tries >= 3) {
      console.log(`Could Not Connect after ${tries} attempts.`);
      return Promise.reject('EXIT');
    }

    console.log('Invalid Username or Password')
    tries ++;

    return config.prompt(config)
      .catch(() => Promise.reject('EXIT'))
      .then((config) =>{
        server = new dwServer(config.hostname, 'dw-utils', config.username, config.password);
        return server.auth()
          .then(() => {
            return config.saveConfig(config).catch(() => {})
          });
      }).catch(authError);
  }

  var current_line = 0
  var upload_queue = []
  var uploading = false

  function bulk_upload(zip_files){
    uploading = true

    var line = out(chalk.yellow.italic(`[ ] Bulk updating ${zip_files.length} items: Uploading...`))
    var files = zip_files.map((file) => {
      return [file.length == 3, file[0]]
    })

    utils.zipFiles(files, cartridges, version, server)
    .catch((error) => {
      out(chalk.red(`[x] Bulk updating ${zip_files.length} items: Zip Error re-trying`), line)
      return utils.zipFiles(files, cartridges, version, server)
    })
    .catch((error) => {
      out(chalk.red(`[x] Bulk updating ${zip_files.length} items: Zip Error, skipping`), line)
      for (var i = 0; i < zip_files.length; i++){
        var file = zip_files[i]
        let failure = chalk.red(stripColor(file[2].replace('[*]', '[x]')));
        out(failure, file[3])
      }
      uploading = false
      process_queue()
    })
    .then((temp) => {
      out(chalk.yellow(`[ ] Bulk updating ${zip_files.length} items: Unzipping...`), line)
      return server.unzip(temp).then(() => {
        return temp
      })
    })
    .then((temp) => {
      out(chalk.yellow.underline(`[ ] Bulk updating ${zip_files.length} items: cleaning up...`), line)
      return server.delete(temp)
    })
    .then(() => {
      out(chalk.green(`[*] Bulk updating ${zip_files.length} items: done`), line)
      for (var i = 0; i < zip_files.length; i++){
        var file = zip_files[i]
        out(file[2], file[3])
      }
    })
    .catch(error => {
      out.chalk.red(`[x] Bulk updating ${zip_files.length} items: ${error.code}`, line)
      for (var i = 0; i < zip_files.length; i++){
        var file = zip_files[i]
        let failure = chalk.red(stripColor(file[2].replace('[*]', '[x]')));
        out(failure, file[3])
      }
      uploading = false
      process_queue()
    })
    .then(() => {
      uploading = false
      process_queue()
    })
  }

  function process_queue(){
    if (upload_queue.length > 0 && upload_queue.length < 5){
      var next = upload_queue.shift()
      if (next.length == 3){ // directory
        upload_dir(next[0], next[1], next[2])
      } else {
        upload_file(next[0], next[1], next[2], next[3])
      }
    } else if (upload_queue.length >= 5){
      var zip_files = upload_queue
      upload_queue = []
      bulk_upload(zip_files)
    }
  }

  function upload_dir(remote, success, line){
    server.mkdir(remote).then(() => {
      out(success, line)
    })
    .catch(error)
    .then(() => {
      uploading = false
      process_queue()
    })
  }

  function upload_file(local, remote, success, line){
    uploading = true
    server.upload(local, remote)
    .then(() => {
      out(success,line)
    })
    .catch(error => {
      let failure = chalk.red(stripColor(success.replace(/\[\*\]/, "[x]")))
      out(failure, line)
    })
    .then(() => {
      uploading = false
      process_queue()
    })
  }

  function out(value, line){
    value = squeeze(value);
    var newline = arguments.length == 1;

    line = line || current_line
    var moved_lines = current_line - line
    var up = '', down = ''
    if (moved_lines > 0){
      up = `\x1b[${moved_lines}A`
      down = `\x1b[${moved_lines}B`
    }
    if (newline){
      console.log(up + '\r\x1b[2K' + value + down + '\r')
    } else {
      process.stdout.write(up + '\r\x1b[2K' + value + down + '\r' )
    }
    if (newline){
      current_line++
    }
    return line
  }

  function upload(event){
    return function(file){
      var display = path.relative(cartridges, file)
      var line = out(chalk.yellow(`[ ] ${display} was ${event}`))
      if (uploading){
        upload_queue.push([file, path.join(version, display),chalk.green(`[*] ${display} was ${event}`), line])
      } else {
        upload_file(file, path.join(version, display),chalk.green(`[*] ${display} was ${event}`), line)
      }
    }
  }

  function unlink(file){
    file = path.relative(cartridges, file)
    var line = out(chalk.yellow(`[ ] ${file} was deleted`))
    server.delete(path.join(version, path.relative(cartridges, file)))
    .then(() => {
      out(chalk.green.strikethrough(`[*] ${file} was deleted`),line)
    })
    .catch(error)
  }

  function mkdir(file){
    var display = path.relative(cartridges, file)
    var line = out(chalk.yellow(`${display} was created`))
    // queue all file creates in a zip file
    upload_queue.push([path.join(version, display), chalk.green(`${display} was created`), line])
    process_queue()
  }

  function error(error){
    out(JSON.stringify(error))
  }

  function ready(){
    out(chalk.yellow.bold(' -- Waiting for changes --'))
  }

  let statusLine = out(chalk.yellow('Connecting ... '))
  server.auth()
    .catch((e) => {
      out(chalk.red('Connecting ... Error'), statusLine)
      return authError(e).then(() => {
        out(chalk.green('Connecting ... success'), statusLine - (3 * tries))
      })
    })
    .then(() => {
      out(chalk.green('Connecting ... success'), statusLine)

      chokidar.watch(cartridges, {
        persistent: true,
        ignored: ignore,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: config.stabilityThreshold,
          pollInterval: 50
        }
      }).on('add'   , upload('added'))
        .on('change', upload('changed'))
        .on('unlink', unlink)
        .on('addDir', mkdir)
        .on('unlinkDir', unlink)
        .on('error', error)
        .on('ready', ready)
    })
    .catch(e => {
      if (e == 'EXIT') return;
      out(chalk.red(e));
    })

}
const lowPriority = [
  new RegExp('/(cartridge)/'),
  new RegExp('/(default)/'),
  new RegExp('/(static)/'),
  new RegExp('(\.generated\.)'),
  new RegExp('( was )'),
  new RegExp('\s(\w*_)'),
  new RegExp('ch(anged)'),
  new RegExp('del(eted)'),
  new RegExp('cr(eated)'),

];

const elipsis = chalk.gray('\u2026');

function chalkStyle(value){
  // return the chalk style function for the value
  const codes = [
    chalkStyles.red.open,
    chalkStyles.green.open,
    chalkStyles.yellow.open,
    chalkStyles.blue.open,
    chalkStyles.magenta.open,
    chalkStyles.cyan.open,
    chalkStyles.white.open,
    chalkStyles.gray.open,
    chalkStyles.black.open,
    chalkStyles.bold.open,
    chalkStyles.dim.open,
    chalkStyles.italic.open,
    chalkStyles.underline.open,
    chalkStyles.inverse.open,
    chalkStyles.strikethrough.open,
    chalkStyles.bgRed.open,
    chalkStyles.bgGreen.open,
    chalkStyles.bgYellow.open,
    chalkStyles.bgBlue.open,
    chalkStyles.bgMagenta.open,
    chalkStyles.bgCyan.open,
    chalkStyles.bgWhite.open,
    chalkStyles.bgBlack.open,
  ];
  const styles = [
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'gray',
    'black',
    'bold',
    'dim',
    'italic',
    'underline',
    'inverse',
    'strikethrough',
    'bgRed',
    'bgGreen',
    'bgYellow',
    'bgBlue',
    'bgMagenta',
    'bgCyan',
    'bgWhite',
    'bgBlack',
  ];

  var style = chalk.reset;
  if (hasColor(value)){
    let colorless = stripColor(value);
    var open = value.substring(0, value.indexOf(colorless));

    for (let i = 0; i < codes.length; i++){
      let code = codes[i];
      if (open.indexOf(code) > -1){
        style = style[styles[i]];
      }
    }
  }
  return style;
}

function length(value){
  return stripColor(value).length;
}

function squeeze(value){
  // Fit input to console;
  let style = chalkStyle(value);
  let width = process.stdout.columns;
  if (process.stdout.isTTY && width && width > 0 && width < length(value)){
    // do the squeezing
    for (let i = 0; length(value) > width && i < lowPriority.length; i++){
      let r = lowPriority[i];
      var m = r.exec(value);
      if (m && m.length > 1){
        let toRemove = length(value) - width;
        let replacement = squeezeMiddle(m[1], toRemove);
        value = style(
          value.substring(0, value.indexOf(m[1], m.index)) +
          replacement.start +
          elipsis +
          replacement.end +
          value.substring(value.indexOf(m[1], m.index) + m[1].length)
        );
      }
    }

    if (length(value) <= width){
      return value;
    }

    let replacement = squeezeMiddle(value, length(value) - width);
    return style(replacement.start + elipsis + replacement.end);
  } else {
    return value;
  }
}

function squeezeMiddle(value, chars){
  //'0123456789' => '01…89'
  // remove `chars` characters from the middle of value;
  if (chars >= length(value)){
    return { start : '', end : ''};
  }
  var start = Math.ceil(( length(value) - (chars + 1) ) / 2)
  return {
    start : sliceAnsi(value, 0,start),
    end : sliceAnsi(value, start + chars + 1),
  }
}

module.exports = watch
