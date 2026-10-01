const embed =
  'https://fstream365.com/embed/movie/52586a3176563141725757713963622b706f2b3472747a4d672f43356e48575437684f615272777a50763035795a5274534a7074796a4f724548474b476e6a6a307563344873316c776a58746a5a36514f6765586a33376344765638626470754467432f5776713774486f782f345a54717335677178344e4f6e4c7835615439/exmovie?srv=6'
const token = embed.match(/embed\/movie\/([^/]+)/)[1]
console.log('token len', token.length)
const raw = Buffer.from(token, 'hex').toString('utf8')
console.log('decoded', raw)
console.log('parts', raw.split('/'))

// compare to working getSources id decoded
const working =
  'AYp3PDornllU8H6B6rTy41khjriiGknNu+Wnh/rT+5NZR/RluIfcmSC5GKaAAx09EXrQgzDKvw8BWJdR4JXuKUFhmSew5tdrwyQXxVsMeweyc2gP7wPKugr7kcVaGNtdExAAhS88GnHm0oi+rc8RiTkkaLtUx2yvex2qW/9mIa+tlKa6wKLsdaCJoLdsyI58koas9Ta4WYAHU5m4bUfE9q0mSsTJEagDopFXKcBk9GJPmlb23kzAzyVfhqTVJ92pPo28lLbL7q7xhDkRQ3VpiA=='
console.log('working in parts?', raw.includes(working.slice(0, 20)))
console.log('part match', raw.split('/').map((p) => p.slice(0, 30)))
