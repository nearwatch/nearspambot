const dotenv 	= require('dotenv').config()
const fetch 	= require('node-fetch')
const FormData 	= require('form-data')
const {Stream}	= require('stream')
const nearApi 	= require('near-api-js')
const Telegraf	= require('telegraf')
const bot       = new Telegraf(process.env.BOT_TOKEN,{handlerTimeout:100})  
const admins 	= process.env.ADMINS && process.env.ADMINS.length?process.env.ADMINS.split(',').map(e => +e):[]
let   queue     = []

const uploadByStream = function (downloadStream) {
  if (!(downloadStream instanceof Stream)) throw new TypeError('Param is not a stream')
  const form = new FormData()
  form.append('file', downloadStream,'blob')
  return fetch('https://telegra.ph/upload',{method:'POST', headers:{'Transfer-Encoding':'chunked'}, body:form})
		 .then(res => res.json())
		 .then(json => {
			if (json.error) throw json.error
			if (json[0] && json[0].src) return `https://telegra.ph${json[0].src}`
			throw new Error('Unrecognized response')
		 })
}
const uploadPhoto = (url) => fetch(url).then(res => uploadByStream(res.body))

balance = async function (accountId) {
	try{
		const network = accountId.substr(-5) == '.near'?'mainnet':'testnet'
		const keyStore = new nearApi.keyStores.InMemoryKeyStore()
		const near = await nearApi.connect({deps:{keyStore},nodeUrl:'https://rpc.'+network+'.near.org'})
		const account = await near.account(accountId)
		return await account.getAccountBalance()
	}catch(err){
		return {error:err.type || err}
	}
}
viewAccountNFT = async function (accountId,contractId) {
	try{
		const network = accountId.substr(-5) == '.near'?'mainnet':'testnet'
		const provider = new nearApi.providers.JsonRpcProvider('https://rpc.'+network+'.near.org')
        const account = new nearApi.Account({provider:provider})
        return await account.viewFunction(contractId,'nft_tokens_for_owner',{account_id:accountId})
	}catch(err){
		return {error:err.type || err}
	}
}
isAccount = async function (accountId) {
	try{
		const network = accountId.substr(-5) == '.near'?'mainnet':'testnet'
		const keyStore = new nearApi.keyStores.InMemoryKeyStore()
		const near = await nearApi.connect({deps:{keyStore},nodeUrl:'https://rpc.'+network+'.near.org'})
		const account = await near.account(accountId)
		return await account.state()
	}catch(err){
		if (err.type!='AccountDoesNotExist') console.log(accountId,err.type)
		return err.type!='AccountDoesNotExist'?{error:err.type}:false
	}
}

sendNFT = async (accountId,destId,tokenId,metadata) => {
    try {
		const network = accountId.substr(-5) == '.near'?'mainnet':'testnet'
		const keyPair = nearApi.utils.KeyPair.fromString(process.env[network.toUpperCase()+'_KEY'])
		const keyStore = new nearApi.keyStores.InMemoryKeyStore()
		keyStore.setKey(network,accountId,keyPair)
		const near = await nearApi.connect({deps:{keyStore},networkId:network,nodeUrl:'https://rpc.'+network+'.near.org'})
		const acc =  await near.account(accountId)
		let tx = await acc.functionCall({contractId:accountId, methodName:'nft_mint', args:{token_id:tokenId, token_owner_id:accountId, token_metadata:metadata}, gas:'100000000000000',attachedDeposit:'1000000000000000000000000'})
		tx = await acc.functionCall({contractId:accountId, methodName:'nft_transfer', args:{token_id:tokenId, receiver_id:destId, copies:1}, gas:'100000000000000',attachedDeposit:'1'})
    return tx.status.Failure?{error:tx.status.Failure}:tx.transaction.hash
	}catch(err) {
		return {error:err.type || err}
	}
}
const processTasks = async function () {
	const tasks = queue.filter(e => e.busy)
	for (const i in tasks){
		const contractId = process.env.ACCOUNT+(tasks[i].addr.substr(-5)==='.near'?'.near':'.testnet')
		let status = 'already has'
		const isAcc = await isAccount(tasks[i].addr)
		if (isAcc && !isAcc.error){
			const nfts = await viewAccountNFT(tasks[i].addr,contractId)
			if (nfts.error || !nfts.find(e => e.metadata && e.metadata.media === tasks[i].url)){
				const tokenId = ''+Date.now()
				let res = await sendNFT(contractId,tasks[i].addr,tokenId,{title:tasks[i].title,media:tasks[i].url,copies:1})
				status = res.error?res.error:'OK'
			} 
		} else status = isAcc?isAcc.error:'account not found'
		const bal = await balance(contractId)
		const baltext = bal && bal.available?'\navailable balance: '+nearApi.utils.format.formatNearAmount(bal.available):'' 
		const userTasks = queue.filter(e => e.user === tasks[i].user)
		const kb = userTasks.length>1?[[{text:'Start', callback_data:'start'},{text:'Stop', callback_data:'stop'}]]:[[]]
		await bot.telegram.editMessageText(tasks[i].user,tasks[i].message,null,'<a href="'+tasks[i].url+'">&#8203;</a>left: '+(userTasks.length-1)+'\n'+tasks[i].addr+' - '+status+baltext+'\n\n'+(tasks[i].title?'title: <i>'+tasks[i].title+'</i>':''),{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}})
	}
	queue = queue.filter(e => !e.busy)
}
const getTasks = function () {
	if (!queue.length || queue.find(e => e.busy)) return
	const users = {}
	for (const i in queue){
		if (users['id'+queue[i].user] || queue[i].stopped) continue
		users['id'+queue[i].user] = 1
		queue[i].busy = 1
	}
	processTasks()	
}
setInterval(getTasks,1000)

const uploadWallets = async function (ctx,text) {
	let addrs = text.toLowerCase().match(new RegExp('([a-z0-9_\.\-]+?\.(testnet|near))','g'))
	if (!addrs) return ctx.reply('No addresses found. Demo version support testnet only.')
	addrs = addrs.filter(e => (admins.indexOf(ctx.from.id)>=0 && e.substr(-5)=='.near') || e.substr(-8)=='.testnet')
	if (!addrs.length) return ctx.reply('No addresses found. Demo version support testnet only.')
	const title = /title\: (.+)/.exec(ctx.message.reply_to_message.text)
	const url = ctx.message.reply_to_message.entities && ctx.message.reply_to_message.entities.find(e => e.url && e.url.substr(0,24) == 'https://telegra.ph/file/')
	if (!url) return ctx.reply('No image found')
	try{
		await ctx.telegram.deleteMessage(ctx.from.id, ctx.message.reply_to_message.message_id)
	}catch(err){}
	const mess = await ctx.reply('<a href="'+url.url+'">&#8203;</a>left: '+addrs.length+(title?'\n\ntitle: <i>'+title[1]+'</i>':''),{parse_mode:'HTML', reply_markup:{inline_keyboard:[[{text:'Start', callback_data:'start'},{text:'Kill', callback_data:'kill'}]]}})
	for (const addr of addrs)
		if (admins.indexOf(ctx.from.id)>=0 || addr.substr(-8) === '.testnet') 
			queue.push({user:ctx.from.id, message:mess.message_id, url:url.url, time:Date.now(), addr:addr, title:title && title[1], stopped:1})
	return ctx.deleteMessage()
}

bot.start(ctx => ctx.reply('Send an image to the bot and reply post with near address'))
bot.command('clear', async ctx => {
	queue = queue.filter(e => e.user!=ctx.from.id)
	return ctx.reply('OK')
})
bot.action('kill', async ctx => {
	queue = queue.filter(e => e.user!=ctx.from.id)
	await ctx.telegram.editMessageReplyMarkup(ctx.from.id,ctx.callbackQuery.message.message_id,null,{inline_keyboard:[[]]})			
	return ctx.answerCbQuery('OK')
})
bot.action('start', async ctx => {
	for (const i in queue) 
		if (queue[i].user == ctx.from.id) queue[i].stopped = 0
	await ctx.telegram.editMessageReplyMarkup(ctx.from.id,ctx.callbackQuery.message.message_id,null,{inline_keyboard:[[{text:'Stop', callback_data:'stop'}]]})			
	return ctx.answerCbQuery()
})
bot.action('stop', async ctx => {
	for (const i in queue) 
		if (queue[i].user == ctx.from.id) queue[i].stopped = 1
	await ctx.telegram.editMessageReplyMarkup(ctx.from.id,ctx.callbackQuery.message.message_id,null,{inline_keyboard:[[{text:'Start', callback_data:'start'},{text:'Kill', callback_data:'kill'}]]})			
	return ctx.answerCbQuery()
})
bot.on('text', async ctx => {
	if (!ctx.message.reply_to_message) return ctx.reply('You need to reply to an image post')
	if (queue.find(e => e.user == ctx.from.id)) return ctx.reply('You still have an unfinished mailing list. For delete it click /clear')
	return uploadWallets(ctx,ctx.message.text)
})	
bot.on('photo',async ctx => {
	try{
		const url = await bot.telegram.getFileLink(ctx.message.photo[ctx.message.photo.length-1].file_id)
		const res = await uploadPhoto(url)
		if (res.error) return ctx.reply('Upload photo error')
		await ctx.deleteMessage()
		return ctx.reply('Reply to this post with a NEAR addresses or a text file with a NEAR address list<a href="'+res+'">&#8203;</a>\n\n'+(ctx.message.caption?'title: <i>'+ctx.message.caption+'</i>':''),{parse_mode:'HTML'})
	}catch(err){return ctx.reply('Upload photo error')}
})
bot.on('message', async ctx => {
	if (!ctx.message.reply_to_message) return ctx.reply('You need to reply to an image post')
	if (!ctx.message.document || ctx.message.document.mime_type!='text/plain') return ctx.reply('You need to reply to an image post with a text file')
	try{
		const res = await fetch(await bot.telegram.getFileLink(ctx.message.document.file_id))
		const text = await res.text()
		return uploadWallets(ctx,text)
	}catch(err){
		return ctx.reply('File upload error')
	}
})
bot.catch(err => console.error(err))
bot.launch({polling:{timeout:60}})
