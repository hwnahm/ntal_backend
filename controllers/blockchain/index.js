const Web3 = require('web3');
const web3 = new Web3(process.env.PROVIDER_URL);
const fs = require('fs');
const consts = require('../../utils/consts');
const logger = require('../../utils/logger');
const {getCoinPrice} = require('../../utils/helper');
const ObjectID = require('mongodb').ObjectID;
const collectionRepository = require('../../repositories/collection_repository');
const tradeRepository = require('../../repositories/trade_repository');
const {NftModel, SerialModel, TransactionModel, ListenerModel, TradeModel} = require('../../models');
// const marketAbi = require('../../config/abi/market.json');
const marketAbi = require('../../config/abi/marketV4.json');
let lastBlock = 0;
let lastMarketBlock = 0;

const marketAddress = process.env.MARKET_CONTRACT_ADDRESS;
const useCrawler = process.env.USE_CRAWLER;
const marketContract = new web3.eth.Contract(marketAbi, marketAddress);

// load last checked block from file
function loadConf() {
    if (fs.existsSync('lastcheckedblock.conf')) {
        let rawdata = fs.readFileSync('lastcheckedblock.conf');
        lastBlock = parseInt(rawdata);
    } else {
        lastBlock = 68397139;
    }
    if (fs.existsSync('lastmarketblock.conf')) {
        let rawdata = fs.readFileSync('lastmarketblock.conf');
        lastMarketBlock = parseInt(rawdata);
    } else {
        lastMarketBlock = 68397139;
    }
}

// save last event's block to file - incase reload service
function saveConf() {
    fs.writeFileSync('lastcheckedblock.conf', lastBlock + '');
}

function saveMarketConf() {
    fs.writeFileSync('lastmarketblock.conf', lastMarketBlock + '');
}

// convert hex result to address
function hexToAddress(hexVal) {
    return '0x' + hexVal.substr(-40);
}

// get events
async function getLastEvents(toBlock) {
    const contracts = await collectionRepository.getContracts();
    // console.log('Contracts : ', contracts);
    web3.eth.getPastLogs(
        // {fromBlock: lastBlock, toBlock: toBlock, address: contractAddress},
        {fromBlock: lastBlock, toBlock: toBlock, address: contracts},
        async (err, result) => {
            if (!err) {
                if (result.length > 0) {
                    lastBlock = result[result.length - 1].blockNumber + 1;
                    console.log('update last block ----->', result);
                    for (let i = 0; i < result.length; i++) {
                        let contract = result[i].address;
                        let collection = await collectionRepository.findByContractAddress(contract);
                        if (!collection) {
                            continue;
                        }
                        let collectionId = new ObjectID(collection._id);
                        let contractAddress = contract.toLowerCase();
                        if (result[i].topics) {
                            if (result[i].topics[0] == '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {// transfer
                                let fromAddress = hexToAddress(result[i].topics[1]);
                                let toAddress = hexToAddress(result[i].topics[2]);
                                let tokenIdDeciaml = web3.utils.hexToNumber(result[i].topics[3]);
                                let tokenIdHex = '0x' + tokenIdDeciaml.toString(16);
                                let transactionHash = result[i].transactionHash;
                                console.log(`tokenIdDeciaml: ${tokenIdDeciaml} hash: ${transactionHash}`);

                                if (fromAddress == '0x0000000000000000000000000000000000000000') {// mint
                                    let nftIds = await SerialModel.aggregate([
                                        {$match: {contract_address: contractAddress, token_id: tokenIdHex}},
                                        {$group: {_id: '$nft_id'}}
                                    ]);
                                    if (nftIds.length > 1) {
                                        const nfts = await NftModel.find({_id: {$in: nftIds}});
                                        for (let i = 0; i < nfts.length; i++) {
                                            if (nfts[i].onchain === 'false') {
                                                // serials 삭제
                                                console.log('duplicate token id onchain false nft id : ', nfts[i]._id);
                                                try {
                                                    const ret1 = await SerialModel.deleteMany({nft_id: nfts[i]._id});
                                                    const ret2 = await NftModel.deleteOne({_id: nfts[i]._id});
                                                    console.log('removed', ret1, ret2);
                                                } catch (e) {
                                                    console.log(e);
                                                }
                                            }
                                        }
                                    }
                                    let serial = await SerialModel.findOneAndUpdate(
                                        {
                                            contract_address: contractAddress,
                                            token_id: tokenIdHex,
                                            owner: null,
                                            status: consts.SERIAL_STATUS.INACTIVE,
                                        },
                                        {$set: {status: consts.SERIAL_STATUS.ACTIVE}},
                                        {returnNewDocument: true},
                                    ).sort({createdAt: -1});
                                    if (!serial) continue;
                                    await ListenerModel.create({
                                        token_id: tokenIdDeciaml,
                                        tx_id: transactionHash,
                                        from: fromAddress,
                                        to: toAddress,
                                        nft_id: serial.nft_id._id,
                                        contract_address: contractAddress,
                                        type: consts.LISTENER_TYPE.MINT,
                                    });
                                    if (serial) await NftModel.findOneAndUpdate({_id: serial.nft_id._id}, {
                                        $inc: {quantity_selling: 1},
                                        status: consts.NFT_STATUS.ACTIVE,
                                    });
                                } else if (toAddress == '0x0000000000000000000000000000000000000000') {// burn
                                    let serial = await SerialModel.findOneAndUpdate(
                                        {contract_address: contractAddress, token_id: tokenIdHex},
                                        {$set: {status: consts.SERIAL_STATUS.SUSPEND}},
                                        {returnNewDocument: true},
                                    );
                                    if (!serial) continue;
                                    await ListenerModel.create({
                                        token_id: tokenIdDeciaml,
                                        tx_id: transactionHash,
                                        nft_id: serial.nft_id._id,
                                        from: fromAddress,
                                        to: toAddress,
                                        contract_address: contractAddress,
                                        type: consts.LISTENER_TYPE.BURN,
                                    });
                                    if (serial) await NftModel.findOneAndUpdate({_id: serial.nft_id._id}, {
                                        $inc: {quantity_selling: -1},
                                        status: consts.NFT_STATUS.SUSPEND,
                                    });
                                } else {// other transfer(buy, airdrop)
                                    let transaction = await TransactionModel.findOneAndUpdate(
                                        {tx_id: transactionHash},
                                        {$set: {status: consts.TRANSACTION_STATUS.SUCCESS}},
                                        {returnNewDocument: true},
                                    );
                                    if (transaction) await SerialModel.findOneAndUpdate({_id: transaction.serial_id._id}, {transfered: consts.TRANSFERED.TRANSFERED});
                                }
                            }
                                // keccak hash : TransferSingle(address,address,address,uint256,uint256)
                            // https://baobab.scope.klaytn.com/tx/0xa376776f1fd040e1e78499c9d15db374b64ccb27d994c2bcd31f7c4a4d9a06a5?tabId=eventLog
                            else if (
                                result[i].topics[0] ==
                                '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'
                            ) {
                                let contractAddress = result[i].address.toLowerCase();
                                const data = web3.eth.abi.decodeParameters(['uint256', 'uint256'], result[i].data);
                                let fromAddress = hexToAddress(result[i].topics[1]);
                                let toAddress = hexToAddress(result[i].topics[2]);
                                console.log('====!!!!', result[i].topics, data);
                                let tokenIdDeciaml = parseInt(data[0]);
                                let tokenIdHex = '0x' + tokenIdDeciaml.toString(16);

                                let transactionHash = result[i].transactionHash;
                                // transfer
                                if (
                                    result[i].topics[2] ==
                                    '0x0000000000000000000000000000000000000000000000000000000000000000'
                                ) {
                                    let nftIds = await SerialModel.aggregate([
                                        {$match: {contract_address: contractAddress, token_id: tokenIdHex}},
                                        {$group: {_id: '$nft_id'}}
                                    ]);
                                    if (nftIds.length > 1) {
                                        const nfts = await NftModel.find({_id: {$in: nftIds}});
                                        for (let i = 0; i < nfts.length; i++) {
                                            if (nfts[i].onchain === 'false') {
                                                // serials 삭제
                                                console.log('duplicate token id onchain false nft id : ', nfts[i]._id);
                                                try {
                                                    const ret1 = await SerialModel.deleteMany({nft_id: nfts[i]._id});
                                                    const ret2 = await NftModel.deleteOne({_id: nfts[i]._id});
                                                    console.log('removed. ', ret1, ret2);
                                                } catch (e) {
                                                    console.log(e);
                                                }
                                            }
                                        }
                                    }
                                    // mint
                                    let result = await SerialModel.updateMany(
                                        {
                                            contract_address: contractAddress,
                                            token_id: tokenIdHex,
                                            owner: null,
                                            status: consts.SERIAL_STATUS.INACTIVE,
                                        },
                                        {$set: {status: consts.SERIAL_STATUS.ACTIVE}},
                                    );
                                    const serial = await SerialModel.findOne({
                                        contract_address: contractAddress,
                                        token_id: tokenIdHex,
                                    }).sort({createdAt: -1});
                                    if (!serial) continue;
                                    await ListenerModel.create({
                                        token_id: tokenIdDeciaml,
                                        tx_id: transactionHash,
                                        nft_id: serial.nft_id._id,
                                        from: fromAddress,
                                        to: toAddress,
                                        contract_address: contractAddress,
                                        type: consts.LISTENER_TYPE.MINT,
                                    });
                                    if (serial) await NftModel.findOneAndUpdate({_id: serial.nft_id._id}, {status: consts.NFT_STATUS.ACTIVE});
                                } else if (
                                    result[i].topics[3] ==
                                    '0x0000000000000000000000000000000000000000000000000000000000000000'
                                ) {
                                    // burn
                                    let amount = data[1];
                                    let result = await SerialModel.updateMany(
                                        {contract_address: contractAddress, token_id: tokenIdHex},
                                        {$set: {status: consts.SERIAL_STATUS.SUSPEND}},
                                        {returnNewDocument: true},
                                    );
                                    const serial = await SerialModel.findOne({
                                        contract_address: contractAddress,
                                        token_id: tokenIdHex,
                                    });
                                    if (!serial) continue;
                                    await ListenerModel.create({
                                        token_id: tokenIdDeciaml,
                                        tx_id: transactionHash,
                                        nft_id: serial.nft_id._id,
                                        from: fromAddress,
                                        to: toAddress,
                                        contract_address: contractAddress,
                                        type: consts.LISTENER_TYPE.BURN,
                                    });
                                    if (serial) await NftModel.findOneAndUpdate({_id: serial.nft_id._id}, {
                                        quantity_selling: 0,
                                        status: consts.NFT_STATUS.SUSPEND,
                                    });
                                } else {
                                    // buy or airdrop nft
                                    // TODO 여러개가 한번에 팔리는 경우에 대한 처리 필요(여러개의 serial 을 suspend 처리해야함?)
                                    let transaction = await TransactionModel.findOneAndUpdate(
                                        {tx_id: transactionHash},
                                        {$set: {status: consts.TRANSACTION_STATUS.SUCCESS}},
                                        {returnNewDocument: true},
                                    );
                                    if (transaction) await SerialModel.findOneAndUpdate({_id: transaction.serial_id._id}, {transfered: consts.TRANSFERED.TRANSFERED});
                                    // // let tokenId = web3.utils.hexToNumber(result[i].topics[3]);
                                    // // tokenId = '0x' + tokenId.toString(16);
                                    // const data = web3.eth.abi.decodeParameters(['uint256', 'uint256'], result[i].data);
                                    // let tokenId = '0x' + data[0].toString(16);
                                    // let amount = data[1];
                                    // console.log(
                                    //     'transfer, from owner:',
                                    //     toAddress(result[i].topics[2]),
                                    //     ' to new owner:',
                                    //     toAddress(result[i].topics[3]),
                                    // );
                                    // console.log('tokenid:', tokenId);
                                    // console.log('amount:', amount);
                                    // console.log('transactionHash', result[i].transactionHash);
                                    //
                                    // let tx = await txRepository.findOneTx({
                                    //     tx_id: result[i].transactionHash,
                                    // });
                                    // console.log("tx::::", tx);
                                    // // let serial = await serialRepository.findOneSerial({
                                    // //     token_id: tokenId,
                                    // //     transfered: consts.TRANSFERED.NOT_TRANSFER,
                                    // //     owner_id: tx.buyer,
                                    // //     status: {
                                    // //         $in: [
                                    // //             consts.SERIAL_STATUS.INACTIVE,
                                    // //             consts.SERIAL_STATUS.ACTIVE,
                                    // //         ],
                                    // //     },
                                    // // });
                                    // let serials = await serialRepository.findAllSerialWithCondition({
                                    //     token_id: tokenId,
                                    //     transfered: consts.TRANSFERED.NOT_TRANSFER,
                                    //     owner_id: tx.buyer,
                                    //     status: {
                                    //         $in: [
                                    //             consts.SERIAL_STATUS.INACTIVE,
                                    //             consts.SERIAL_STATUS.ACTIVE,
                                    //         ],
                                    //     },
                                    // });
                                    // // console.log("serial::::", serial);
                                    //
                                    // // if (serial && tx) {
                                    // if (serials && tx) {
                                    //     let ids = [];
                                    //     serials.forEach((serial) => {
                                    //         ids.push(serial._id);
                                    //     })
                                    //     await serialRepository.update(
                                    //         // {_id: serial._id},
                                    //         {_id: {$in: ids}},
                                    //         {transfered: consts.TRANSFERED.TRANSFERED, tx_id: tx.tx_id},
                                    //     );
                                    //     await txRepository.update(
                                    //         {_id: tx._id},
                                    //         {
                                    //             status: consts.TRANSACTION_STATUS.SUCCESS,
                                    //         },
                                    //     );
                                    // }
                                }
                            } else if (result[i].topics[0] == '0x000000') {
                                // approve chưa biết mã topic nên chưa xong
                            }
                        }
                    }
                }
                lastBlock = toBlock + 1;
                saveConf();
                return true;
            }
            console.log(err);
        },
    ).catch((e) => {
        console.log('collection contract getEvents', e);
    });
}

async function getMarketEvents(toBlock) {
    await marketContract.getPastEvents('allEvents', {fromBlock: lastMarketBlock, toBlock: toBlock})
        .then(async function(events) {
            let coinPrice;
            if (events.length > 0) {
                coinPrice = await getCoinPrice();
            }
            for (let i = 0; events.length > i; i++) {
                try {
                    if (events[i].event === 'Trade') {
                        console.log(events[i].transactionHash, 'Trade event handle start.');
                        const tokenIdHex = '0x' + parseInt(events[i].returnValues.tokenId, 10).toString(16);
                        console.log(events[i].returnValues);
                        let serials = await SerialModel.find({
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            token_id: tokenIdHex,
                            buyer: events[i].returnValues.buyer,
                            status: consts.SERIAL_STATUS.BUYING,
                        });
                        const serialIds = serials.map((doc) => doc._id);
                        const result = await SerialModel.updateMany(
                            {_id: {$in: serialIds}},
                            {
                                $set: {
                                    status: consts.SERIAL_STATUS.ACTIVE,
                                    owner_id: events[i].returnValues.buyer,
                                    seller: null,
                                    buyer: null,
                                },
                            },
                        );
                        if (serialIds.length === 0) continue;
                        const block = await web3.eth.getBlock(events[i].blockNumber).catch(e => console.log('getBlock fail', e));
                        console.log(block.timestamp, serials[0].nft_id._id);
                        const nft = await NftModel.findOne({_id: serials[0].nft_id._id});
                        //     {$inc: {quantity_selling: -1}}, {returnNewDocument: true});
                        console.log(web3.utils.fromWei(events[i].returnValues.price, 'ether'), web3.utils.fromWei(events[i].returnValues.fee, 'ether'));
                        const trade = await TradeModel.create({
                            tx_hash: events[i].transactionHash,
                            block_number: events[i].blockNumber,
                            chain_id: process.env.KLAYTN_CHAIN_ID,
                            seller: events[i].returnValues.seller,
                            buyer: events[i].returnValues.buyer,
                            contract_address: events[i].returnValues.nft,
                            token_id: tokenIdHex,
                            price: web3.utils.fromWei(events[i].returnValues.price, 'ether'),
                            fee: web3.utils.fromWei(events[i].returnValues.fee, 'ether'),
                            quote: nft.quote,
                            collection_id: nft.collection_id,
                            trade_date: new Date(block.timestamp * 1000),
                        });
                        // update hour trade statistics
                        let hourIndex = Math.floor(block.timestamp / 3600);
                        let hourStartUnix = hourIndex * 3600;
                        await tradeRepository.updateHourData(trade.collection_id, hourStartUnix, trade.price, trade.quote, coinPrice);
                        // update day trade statistics
                        let dayID = Math.floor(block.timestamp / 86400);
                        let dayStartUnix = dayID * 86400;
                        await tradeRepository.updateDayData(trade.collection_id, dayStartUnix, trade.price, trade.quote, coinPrice);

                        const history = {
                            token_id: events[i].returnValues.tokenId,
                            tx_id: events[i].transactionHash,
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            nft_id: nft._id,
                            from: marketAddress,
                            to: events[i].returnValues.buyer,
                            quantity: events[i].returnValues.quantity,
                            price: trade.price,
                            quote: trade.quote,
                            block_number: events[i].blockNumber,
                            block_date: new Date(block.timestamp * 1000),
                            type: consts.LISTENER_TYPE.BUY,
                        };
                        await ListenerModel.create(history);
                        console.log(events[i].transactionHash, 'Trade create success.');
                    } else if (events[i].event === 'CancelSellToken') {
                        // console.log(events[i]);
                        console.log('=====>Cancel', events[i]);
                        const tokenIdHex = '0x' + parseInt(events[i].returnValues.tokenId, 10).toString(16);
                        let serials = await SerialModel.find({
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            token_id: tokenIdHex,
                        });
                        if (serials.length === 0) continue;
                        const block = await web3.eth.getBlock(events[i].blockNumber).catch(e => console.log('getBlock fail', e));
                        const history = {
                            token_id: events[i].returnValues.tokenId,
                            tx_id: events[i].transactionHash,
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            nft_id: serials[0].nft_id._id,
                            from: marketAddress,
                            to: events[i].returnValues.seller,
                            quantity: events[i].returnValues.quantity,
                            price: web3.utils.fromWei(events[i].returnValues.price, 'ether'),
                            quote: events[i].returnValues.quote === '0x0000000000000000000000000000000000000000' ? 'klay' : 'talk',
                            block_number: events[i].blockNumber,
                            block_date: new Date(block.timestamp * 1000),
                            type: consts.LISTENER_TYPE.CANCEL,
                        };
                        await ListenerModel.create(history);
                    } else if (events[i].event === 'Ask') {
                        // what mean Ask event??
                        console.log('=====>Ask', events[i]);
                        // console.log(events[i]);
                        const tokenIdHex = '0x' + parseInt(events[i].returnValues.tokenId, 10).toString(16);
                        let serials = await SerialModel.find({
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            token_id: tokenIdHex,
                        });
                        if (serials.length === 0) continue;
                        const block = await web3.eth.getBlock(events[i].blockNumber).catch(e => console.log('getBlock fail', e));

                        const history = {
                            token_id: events[i].returnValues.tokenId,
                            tx_id: events[i].transactionHash,
                            contract_address: events[i].returnValues.nft.toLowerCase(),
                            nft_id: serials[0].nft_id._id,
                            from: events[i].returnValues.seller,
                            to: marketAddress,
                            quantity: events[i].returnValues.quantity,
                            price: web3.utils.fromWei(events[i].returnValues.price, 'ether'),
                            quote: events[i].returnValues.quote === '0x0000000000000000000000000000000000000000' ? 'klay' : 'talk',
                            block_number: events[i].blockNumber,
                            block_date: new Date(block.timestamp * 1000),
                            type: consts.LISTENER_TYPE.SELL,
                        };
                        await ListenerModel.create(history);
                    }
                } catch (e) {
                    console.log(e);
                }
            }
            lastMarketBlock = toBlock + 1;
            saveMarketConf();
        }).catch((e) => {
            console.log('market contract getEvents', e);
        });
}

if (useCrawler === 'true') {
    // init
    loadConf();

    // set timer to get events every 2 seconds
    setInterval(async function() {
        const delay = process.env.CRAWLER_DELAY;
        let toBlock = (await web3.eth.getBlockNumber()) * 1;
        await getMarketEvents(toBlock);
        toBlock = toBlock - delay;
        if (toBlock - lastBlock > 4000) {
            toBlock = lastBlock * 1 + 4000 - delay;
        }
        getLastEvents(toBlock);
    }, 2000);
}


