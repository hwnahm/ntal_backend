var {validationResult} = require('express-validator');
var nftRepository = require('../../repositories/nft_repository');
var serialRepository = require('../../repositories/serial_repository');
var companyRepository = require('../../repositories/company_repository');
var txRepository = require('../../repositories/transaction_repository');
const {addMongooseParam, getHeaders, checkTimeCurrent} = require('../../utils/helper');
const userRepository = require('../../repositories/user_repository');
var ErrorMessage = require('../../utils/errorMessage').ErrorMessage;
var ObjectID = require('mongodb').ObjectID;
var logger = require('../../utils/logger');
var consts = require('../../utils/consts');
var {handlerSuccess, handlerError} = require('../../utils/handler_response');

module.exports = {
    classname: 'NftController',

    async getTopArtists(req, res, next) {
        try {
            let countCompany = await companyRepository.count({});

            let companyList = await companyRepository.findAll({}, {page: 1, perPage: countCompany});
            let data = [];
            for (let i = 0; i < companyList.length; i++) {
                let input = {
                    company_id: companyList[i]._id,
                    start_date: {$lt: new Date()},
                    end_date: {$gt: new Date()},
                };
                let countNft = await nftRepository.count(input);
                let newNfts = await nftRepository.getNewNfts(input);
                data.push({
                    company: companyList[i],
                    nfts: newNfts,
                    value: countNft,
                });
            }

            //sort with value
            data.sort(function (a, b) {
                return b.value - a.value;
            });

            return handlerSuccess(req, res, data);
        } catch (error) {
            logger.error(new Error(error));
            return handlerError(req, res, error);
        }
    },

    async indexNfts(req, res, next) {
        try {
            var findParams = getFindParams(req.query);
            let page = +req.query.page || 1;
            let perPage = +req.query.perPage || 20;

            let current_time = new Date();

            findParams.type = 0;
            findParams.status = 'active';
            findParams.start_date = {$lte: current_time};
            findParams.end_date = {$gt: current_time};
            findParams.selling_status = consts.SELLING_STATUS.SELL;
            // findParams.quantity_selling = {$gt: 0};

            //get all nft
            const nfts = await nftRepository.findAll(findParams, {page, perPage});

            const count = await nftRepository.count(findParams);
            const responseHeaders = getHeaders(count, page, perPage);

            if (!nfts) {
                return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
            }

            return handlerSuccess(req, res, {
                items: nfts,
                headers: responseHeaders,
            });
        } catch (error) {
            logger.error(new Error(error));
            next(error);
        }
    },

    async indexAirdrops(req, res, next) {
        try {
            let page = +req.query.page || 1;
            let perPage = +req.query.perPage || 20;

            let readFrom = (page - 1) * perPage;
            let readTo = page * perPage;

            let airdrops = [];
            let airdropsPage = [];

            const sellingFindParams = getFindParams(req.query, 'selling');
            const soonFindParams = getFindParams(req.query, 'soon');
            const closedFindParams = getFindParams(req.query, 'closed');

            const countSellingAirdrops = await nftRepository.count(sellingFindParams);
            const countSoonAirdrops = await nftRepository.count(soonFindParams);
            const countClosedAirdrops = await nftRepository.count(closedFindParams);
            const countallAirdrops = countSellingAirdrops + countSoonAirdrops + countClosedAirdrops;

            if (readFrom < countSellingAirdrops) {
                let sellingAirdrops = await nftRepository.findAll(sellingFindParams);

                sellingAirdrops = JSON.parse(JSON.stringify(sellingAirdrops));
                for (let i = 0; i < sellingAirdrops.length; i++) {
                    sellingAirdrops[i].selling_time_status = consts.SELLING_TIME_STATUS.SELLING;
                }
                airdrops = airdrops.concat(sellingAirdrops);

                if (airdrops.length < readTo) {
                    let soonAirdrops = await nftRepository.findAll(soonFindParams);
                    soonAirdrops = JSON.parse(JSON.stringify(soonAirdrops));
                    for (let i = 0; i < soonAirdrops.length; i++) {
                        soonAirdrops[i].selling_time_status =
                            consts.SELLING_TIME_STATUS.COMMING_SOON;
                    }
                    airdrops = airdrops.concat(soonAirdrops);
                }

                if (airdrops.length < readTo) {
                    let closedAirdrops = await nftRepository.findAll(closedFindParams);
                    closedAirdrops = JSON.parse(JSON.stringify(closedAirdrops));

                    for (let i = 0; i < closedAirdrops.length; i++) {
                        closedAirdrops[i].selling_time_status = consts.SELLING_TIME_STATUS.CLOSED;
                    }
                    airdrops = airdrops.concat(closedAirdrops);
                }

                airdropsPage = airdrops.slice(readFrom, readTo);
            } else if (readFrom < countSellingAirdrops + countSoonAirdrops) {
                let soonAirdrops = await nftRepository.findAll(soonFindParams);
                soonAirdrops = JSON.parse(JSON.stringify(soonAirdrops));
                for (let i = 0; i < soonAirdrops.length; i++) {
                    soonAirdrops[i].selling_time_status = consts.SELLING_TIME_STATUS.COMMING_SOON;
                }
                airdrops = airdrops.concat(soonAirdrops);

                if (airdrops.length < readTo - countSellingAirdrops) {
                    let closedAirdrops = await nftRepository.findAll(closedFindParams);
                    closedAirdrops = JSON.parse(JSON.stringify(closedAirdrops));
                    for (let i = 0; i < closedAirdrops.length; i++) {
                        closedAirdrops[i].selling_time_status = consts.SELLING_TIME_STATUS.CLOSED;
                    }
                    airdrops = airdrops.concat(closedAirdrops);
                }

                airdropsPage = airdrops.slice(
                    readFrom - countSellingAirdrops,
                    readTo - countSellingAirdrops,
                );
            } else {
                let closedAirdrops = await nftRepository.findAll(closedFindParams);
                closedAirdrops = JSON.parse(JSON.stringify(closedAirdrops));
                for (let i = 0; i < closedAirdrops.length; i++) {
                    closedAirdrops[i].selling_time_status = consts.SELLING_TIME_STATUS.CLOSED;
                }
                airdrops = airdrops.concat(closedAirdrops);

                airdropsPage = airdrops.slice(
                    readFrom - countSellingAirdrops - countSoonAirdrops,
                    readTo - countSellingAirdrops - countSoonAirdrops,
                );
            }

            if (airdrops.length === 0) {
                return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
            }

            const responseHeaders = getHeaders(countallAirdrops, page, perPage);

            return handlerSuccess(req, res, {
                items: airdropsPage,
                headers: responseHeaders,
            });
        } catch (error) {
            logger.error(new Error(error));
            next(error);
        }
    },

    async getSellingCount(req, res, next) {
        try {
            if (ObjectID.isValid(req.params.id) === false) {
                return handlerError(req, res, ErrorMessage.ID_IS_INVALID);
            }
            let data = {_id: req.params.id};
            let nft = await nftRepository.findQuantitySelling(data);
            if (!nft) {
                return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
            }
            nft = JSON.parse(JSON.stringify(nft));

            return handlerSuccess(req, res, nft);
        } catch (error) {
            logger.error(new Error(error));
            next(error);
        }
    },

    async getDetailNft(req, res, next) {
        try {
            if (ObjectID.isValid(req.params.id) === false) {
                return handlerError(req, res, ErrorMessage.ID_IS_INVALID);
            }

            let uid = req.query.uid;

            let nft = await nftRepository.findById(req.params.id);
            if (!nft) {
                return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
            }

            let onSale = false;
            let current_time = new Date();

            if (checkTimeCurrent(nft.start_date, current_time, nft.end_date) === true) {
                if (nft.quantity_selling > 0) {
                    onSale = true;
                }
            }

            nft = JSON.parse(JSON.stringify(nft));

            const serials = await serialRepository.findByNftId(nft._id);
            
            // serial에 owner가 박혀있다면 체크 (한번이라도 collect를 한적이 있다면 체크됨)
            let ownerCheck = false;
            let collected = false;
            let transfered = false;
            let ownTokenId = "";

            for (let i = 0; i < serials.length; i++) {
                if (serials[i].owner_id != null) {
                    if (serials[i].owner_id.uid == uid) {
                            ownerCheck = true;
                        if (serials[i].transfered == consts.TRANSFERED.NOT_TRANSFER) {
                            collected = true;
                            transfered = false;
                            ownTokenId = parseInt(serials[i].token_id,16).toString();
                            break;
                        }
                    }
                }
            }

            nft.ownerCheck = ownerCheck;
            nft.collected = collected;
            nft.transfered = transfered;
            nft.ownTokenId = ownTokenId;
            nft.onSale = onSale;

            return handlerSuccess(req, res, nft);
        } catch (error) {
            logger.error(new Error(error));
            next(error);
        }
    },

    async getDetailNftBySerial(req, res, next) {
        try {
            if (ObjectID.isValid(req.params.id) === false) {
                return handlerError(req, res, ErrorMessage.ID_IS_INVALID);
            }
            let uid = req.query.uid;
            let serialId = req.query.serialId;

            let nft = await nftRepository.findById(req.params.id);
            if (!nft) {
                return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
            }

            let onSale = false;
            let current_time = new Date();

            if (checkTimeCurrent(nft.start_date, current_time, nft.end_date) === true) {
                if (nft.quantity_selling > 0) {
                    onSale = true;
                }
            }

            nft = JSON.parse(JSON.stringify(nft));

            const serial = await serialRepository.findByIdSerial(serialId);
            let collected = false;
            let transfered = false;
            let ownTokenId = "";
            if (serial.owner_id != null) {
                if (serial.owner_id.uid == uid) {
                    if (serial.transfered == consts.TRANSFERED.NOT_TRANSFER) {
                        collected = true;
                        transfered = false;
                        ownTokenId = parseInt(serial.token_id,16).toString();
                   } else if (serial.transfered == consts.TRANSFERED.TRANSFERED) {
                        collected = true;
                        transfered = true;
                        ownTokenId = parseInt(serial.token_id,16).toString();
                   }
                }
            }
            const tx = await txRepository.findOneTx({serial_id: serialId});
            nft.serialId = serial;
            nft.collected = collected;
            nft.transfered = transfered;
            nft.ownTokenId = ownTokenId;
            nft.onSale = onSale;
            nft.transaction = tx;

            return handlerSuccess(req, res, nft);
        } catch (error) {
            logger.error(new Error(error));
            next(error);
        }
    },
    

    // async getDetailNft(req, res, next) {
    //     try {
    //         if (ObjectID.isValid(req.params.id) === false) {
    //             return handlerError(req, res, ErrorMessage.ID_IS_INVALID);
    //         }

    //         let address = req.query.address;
    //         let uid = req.query.uid;

    //         let nft = await nftRepository.findById(req.params.id);
    //         if (!nft) {
    //             return handlerError(req, res, ErrorMessage.NFT_IS_NOT_FOUND);
    //         }

    //         let onSale = false;
    //         let current_time = new Date();

    //         if (checkTimeCurrent(nft.start_date, current_time, nft.end_date) === true) {
    //             if (nft.quantity_selling > 0) {
    //                 onSale = true;
    //             }
    //         }

    //         nft = JSON.parse(JSON.stringify(nft));

    //         const serials = await serialRepository.findByNftId(nft._id);

    //         let collected = false;
    //         let transfered = false;
    //         let ownTokenId = "";
    //         let collects = [];
    //         let ownTokens = [];

    //         if(uid) {
    //             for (let i = 0; i < serials.length; i++) {
    //                 if (serials[i].owner_id != null) {
    //                     if (serials[i].owner_id.uid == uid) {
    //                         if (serials[i].transfered == consts.TRANSFERED.NOT_TRANSFER) {
    //                             // collected = true;
    //                             transfered = false;
    //                             ownTokenId = parseInt(serials[i].token_id,16).toString();
    //                             collects.push(ownTokenId);
    //                         }
    //                     }
    //                 }
    //             }

    //             for (let i = 0; i < serials.length; i++) {
    //                     if (nft.ipfs_links != null) {
    //                         for (let j = 0; j < collects.length; j++) {
    //                             if (nft.ipfs_links[i].tokenId == collects[j]) {
    //                                 let collectData = {
    //                                     ownTokenId: nft.ipfs_links[i].tokenId,
    //                                     ownIpfsLink: nft.ipfs_links[i].path
    //                                 }
    //                                 ownTokens.push(collectData); 
    //                             }
    //                         }
    //                     }
    //             }
    //             nft.ownTokens = ownTokens;
    //     }
    //         nft.collected = collected;
    //         nft.transfered = transfered;
    //         nft.onSale = onSale;

    //         return handlerSuccess(req, res, nft);
    //     } catch (error) {
    //         logger.error(new Error(error));
    //         next(error);
    //     }
    // },
};

function getFindParams(filters, sellingTimeStatus = null) {
    let findParams = {};

    if (filters.status) {
        findParams.status = filters.status;
    }

    // findParams.start_date = addMongooseParam(findParams.start_date, '$ne', null);

    // if (typeof quantity_selling !== 0) {
    // findParams.quantity_selling = addMongooseParam(findParams.quantity_selling, '$ne', 0);
    // }

    if (filters.type) {
        findParams.type = filters.type;
    }

    if (filters.category) {
        findParams.category = filters.category;
    }

    if (filters.company_id && ObjectID.isValid(filters.company_id) === true) {
        findParams.company_id = addMongooseParam(findParams.company_id, '$eq', filters.company_id);
    }

    if (filters.collection_id && ObjectID.isValid(filters.collection_id) === true) {
        findParams.collection_id = addMongooseParam(
            findParams.collection_id,
            '$eq',
            filters.collection_id,
        );
    }

    if (sellingTimeStatus == 'closed') {
        findParams.$or = [
            {
                end_date: addMongooseParam(findParams.end_date, '$lte', new Date()),
            },
            {
                quantity_selling: 0,
            },
            {
                selling_status: consts.SELLING_STATUS.STOP,
            },
        ];
    }

    if (sellingTimeStatus == 'selling') {
        findParams.end_date = addMongooseParam(findParams.end_date, '$gt', new Date());
        findParams.start_date = addMongooseParam(findParams.start_date, '$lte', new Date());
        findParams.quantity_selling = addMongooseParam(findParams.quantity_selling, '$gt', 0);
        findParams.selling_status = addMongooseParam(
            findParams.selling_status,
            '$ne',
            consts.SELLING_STATUS.STOP,
        );
    }

    if (sellingTimeStatus == 'soon') {
        findParams.start_date = addMongooseParam(findParams.start_date, '$gt', new Date());
        findParams.quantity_selling = addMongooseParam(findParams.quantity_selling, '$gt', 0);
        findParams.selling_status = addMongooseParam(
            findParams.selling_status,
            '$ne',
            consts.SELLING_STATUS.STOP,
        );
    }

    // findParams.start_date = addMongooseParam(findParams.start_date, '$lt', toDate);

    const findByName = Object.assign({}, findParams);
    const findByDesc = Object.assign({}, findParams);
    const findByMetadataName = Object.assign({}, findParams);

    if (filters.searchKey) {
        findByName.name = addMongooseParam(
            findByName.name,
            '$regex',
            new RegExp(filters.searchKey, 'i'),
        );

        findByMetadataName['metadata.name'] = addMongooseParam(
            findByMetadataName['metadata.name'],
            '$regex',
            new RegExp(filters.searchKey, 'i'),
        );

        findByDesc.description = addMongooseParam(
            findByDesc.description,
            '$regex',
            new RegExp(filters.searchKey, 'i'),
        );
    }

    const searchParams = {
        $or: [findByName, findByDesc, findByMetadataName],
    };

    return searchParams;
}
