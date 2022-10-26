const Moralis = require("moralis/node");
const TRANSACTION_MAX = 20000; // max length of fetched transaction to avoid rate limit error
const { get_debank_token } = require("./debank");
const { chainCoins } = require("../constant");
const config = require("./../config");
const MORALLIS_SETTINGS = config.CONFIG.moralis;
const covalent_key = config.CONFIG.covalentKey;
const maxRetryCnt = config.CONFIG.maxRetryCnt;
const { chainApis } = require("../constant");
const axios = require("axios");
const moment = require("moment");
const Moralis_Page_size = 100; //Changed in Moralis API as of 6/1/2022
const MODE_SETTING = require("./../config").CONFIG.mode;

function removeDuplicates(array) {
  return [...new Set(array.map((s) => JSON.stringify(s)))].map((s) =>
    JSON.parse(s)
  );
}

const LatestPriceNumber = require("../models/latestPrice");
const PriceModelList = {
  eth: require("../models/ethPrice"),
  polygon: require("../models/maticPrice"),
  bsc: require("../models/bscPrice"),
  fantom: require("../models/ftmPrice"),
  avalanche: require("../models/avaxPrice"),
};
const { debank_chain_details } = require("../constant");

const latestBlockHeight = {
  eth: -1,
  polygon: -1,
  bsc: -1,
  fantom: -1,
  avalanche: -1,
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const STATE = {
  started: false,
};

async function getTokenMetadata(_chain, _tokenAddresses) {
  let options;
  try {
    var page = 0,
      tokenMetadata = [],
      result;
    while (page < Math.ceil(_tokenAddresses.length / 10)) {
      options = {
        chain: _chain,
        addresses: _tokenAddresses.splice(0, 10),
      };
      result = await Moralis.Web3API.token.getTokenMetadata(options);
      tokenMetadata = tokenMetadata.concat(result);
      page++;
    }
    return tokenMetadata;
  } catch (e) {
    console.log("get token meta data error", e);
    throw e;
  }
}

async function getTransactions(
  _chain,
  _tokenAddress,
  _toBlock,
  _result_max = TRANSACTION_MAX
) {
  let results = [];
  let tmpResults = [];
  let lastTransactionHash = '';
  let startBlock = 0;

  while(1) {
    const { data } = await axios.get(`${chainApis[_chain].serveUrl}api?module=account&action=txlist&address=${_tokenAddress}&startblock=${startBlock}&endblock=${_toBlock}&sort=asc&apikey=${chainApis[_chain].apiKey}`);

    if (data.status === '1' && data.message === 'OK') {
      const lastTransactionIdx = data.result.length - 1;
      const lastTransaction = data.result[lastTransactionIdx];

      if (lastTransactionHash === lastTransaction.hash) {
        tmpResults.push(...data.result);
        break;
      }

      startBlock = lastTransaction.blockNumber;
      lastTransactionHash = lastTransaction.hash;

      // Remove potentially duplicate transactions
      for (let i = lastTransactionIdx; i >= 0; i--) {
        if (data.result[i].blockNumber === startBlock) {
          data.result.pop();
        } else {
          break;
        }
      }

      tmpResults.push(...data.result);
    } else {
      break;
    }
  }

  tmpResults.map((result, index) => {
    let tmpResult = {};
    tmpResult.hash = result.hash;
    tmpResult.nonce = result.nonce;
    tmpResult.from_address = result.from;
    tmpResult.to_address = result.to;
    tmpResult.value = result.value;
    tmpResult.gas = result.gas;
    tmpResult.gas_price = result.gasPrice;
    tmpResult.input = result.input;
    tmpResult.receipt_cumulative_gas_used = result.cumulativeGasUsed;
    tmpResult.receipt_gas_used = result.gasUsed;
    tmpResult.receipt_contract_address = result.contractAddress;
    tmpResult.receipt_root = null;
    tmpResult.receipt_status = result.txreceipt_status;
    tmpResult.block_timestamp = new Date(Number(result.timeStamp) * 1000).toISOString();
    tmpResult.block_number = result.blockNumber;
    tmpResult.block_hash = result.blockHash;
    tmpResult.transfer_index = [ tmpResult.block_number, tmpResult.transaction_index ];
    results.push(tmpResult);
  });
  
  const returnResults = {
    transactions: results,
    txCount: results.length,
  };

  return returnResults;
}
async function getPriceDB(_chain, _toBlock, _address) {
  if (latestBlockHeight[_chain] == -1) {
    return null;
  }

  let price = 0;
  const PriceModel = PriceModelList[_chain];
  if (_toBlock && _toBlock < latestBlockHeight[_chain]) {
    const priceStep = chainCoins[_chain].priceStep;
    const blockNum = Math.floor((_toBlock / priceStep).toFixed(0)) * priceStep;
    const result = await PriceModel.findOne({
      block_height: blockNum,
    }).exec();
    if (result != null) {
      price = result.price;
      console.log(
        `Cached price: chain-${_chain} token-${_address} block-${blockNum}=${price}`
      );
      return price;
    }
  }
  return null;
}

async function getPriceMoralisAPI(_chain, _address, _toBlock, token_in_cache) {
  let options = { address: _address, chain: _chain };
  if (_toBlock) options.to_block = _toBlock;

  //By default, Moralis on ETH searches 1. uniswap-v3 2.sushiswap 3.uniswap-v2, gets first non-null
  //   but uniswap-v2 had more a accurate price ($1) than sushiswap ($1000) for TUSD on block 11343428 (in Nov 2020)
  //  so, for eth blocks older than Jan 1 2021, use uniswap-v2 rather than sushiswap
  if (_chain == "eth" && _toBlock < 11565019) options.exchange = "uniswap-v2";

  let retryCnt = maxRetryCnt;
  while (retryCnt--) {
    try {
      price = await Moralis.Web3API.token.getTokenPrice(options);
      return price.usdPrice;
    } catch (e) {
      //Illiquid token
      if (
        e.error &&
        (e.error.includes("No pools found with enough liquidity") ||
          e.error.includes("Could not determine native-usd price"))
      ) {
        return null; //Illiquid means no price available
      } else if (
        e.error &&
        e.error.includes(
          "This Moralis Server is rate-limited because of the plan restrictions"
        )
      ) {
        console.log("---Moralis rate limit, plan restriction");
      } else {
        //Other error
        console.log(e);
      }
    }
    const delayTime = Number(1000 + 4000 * Math.random()).toFixed(0);
    console.log(
      `Retrying getTokenPrice after ${delayTime} milisecond for ` +
      `${token_in_cache?.name || "<No name>"
      } (${_address}), ${_chain} block ${_toBlock}`
    );
    await new Promise((resolve) => setTimeout(resolve, delayTime));
  }
  console.log(
    `   Moralis: ${maxRetryCnt} failed price retries for ${_address}, ${_chain} block ${_block}`
  );
  return null;
}

async function getOldTokenPrice(
  _chain,
  _address,
  _toBlock,
  global_token_info_debank,
  token_info,
  isFastMode = true,
  //If a token comes up illiquid more than this many times, stop trying to price it.)
  max_price_checks = 2
) {
  let price = null; //the result

  //If native coin, check wrapped version
  if (_address == chainCoins[_chain].native_coin.toLowerCase())
    _address = chainCoins[_chain].address;

  const token_in_cache = await get_debank_token(
    _chain,
    _address,
    global_token_info_debank
  );

  if (!_toBlock && token_in_cache.price > 0) return token_in_cache.price;
  if (token_in_cache?.illiquid_score || 0 > max_price_checks) return null;

  if (_address == chainCoins[_chain].address && isFastMode) {
    price = await getPriceDB(_chain, _toBlock, _address);
    if (price) return price;
    else if (_toBlock)
      console.log(
        `   Price/MongoDB fail for ${
          token_in_cache?.name || "<No name>"
        } (${_address}) ${_chain} block ${_toBlock}`
      );
  }

  price = getPriceMoralisAPI(_chain, _address, _toBlock);
  if (!price) {
    if (token_in_cache.illiquid_score) token_in_cache.illiquid_score++;
    else token_in_cache.illiquid_score = 1;
    console.log(
      `   Price/Moralis fail for ${
        token_in_cache?.name || "<No name>"
      } (${_address}) ${_chain} block ${_toBlock}`
    );
  }
  return price;
}

async function getMoralisPrice(
  _chain,
  _address,
  _toBlock,
  global_token_info_debank,
  token_info,
  isFastMode = true,
  //If a token comes up illiquid more than this many times, stop trying to price it.)
  max_price_checks = 2
) {
  let price = null; //the result

  //If native coin, check wrapped version
  if (_address == chainCoins[_chain].native_coin.toLowerCase())
    _address = chainCoins[_chain].address;

  const token_in_cache = await get_debank_token(
    _chain,
    _address,
    global_token_info_debank
  );

  if (!_toBlock && token_in_cache.price > 0) return token_in_cache.price;
  if (token_in_cache?.illiquid_score || 0 > max_price_checks) return null;

  if (_address == chainCoins[_chain].address && isFastMode) {
    price = await getPriceDB(_chain, _toBlock, _address);
    if (price) return price;
    else if (_toBlock)
      console.log(
        `   Price/MongoDB fail for ${
          token_in_cache?.name || "<No name>"
        } (${_address}) ${_chain} block ${_toBlock}`
      );
  }

  price = getPriceMoralisAPI(_chain, _address, _toBlock, token_in_cache);
  if (!price) {
    if (token_in_cache.illiquid_score) token_in_cache.illiquid_score++;
    else token_in_cache.illiquid_score = 1;
    console.log(
      `   Price/Moralis fail for ${
        token_in_cache?.name || "<No name>"
      } (${_address}) ${_chain} block ${_toBlock}`
    );
  }
  return price;
}
async function getTokenPrice(
  chain,
  token,
  blockheight,
  global_token_info_debank,
  fastMode,
  deposit_address = null,
  wallet_value_in_chain = null,
  debank_wrapped_tokens = null,
  hierarchy_level = 0,
  balance = 0,
  block = null,
  wallet = ""
) {
  let token_info = null;
  let price = null;
  if (!deposit_address && token) {
    token_info = await get_debank_token(chain, token, global_token_info_debank);
    token_info.decimals = token_info?.decimals || 18;
    if (blockheight) {
      //historical price
      price = await getMoralisPrice(
        chain,
        token,
        blockheight,
        global_token_info_debank,
        token_info,
        fastMode
      );
    } else {
      //current price
      price = token_info.price;
    }
  }

  //Price reality check
  //   If units * price >10x total value of the wallet,
  //    it's probably an incorrect price. Try another pricing source.
  if (
    (Number(balance) / 10 ** (token_info?.decimals || 18)) * price >
    wallet_value_in_chain * 10
  )
    price = null;

  //Wrapped token? Get price of the underlying
  if (hierarchy_level > 1 && !price && !token_info?.is_core) {
    const wrapped_token = debank_wrapped_tokens.find(
      (wrap) =>
        (wrap.asset.includes(token) || wrap.debt.includes(token)) &&
        wrap.chain == chainCoins[chain].chainId
    );
    if (wrapped_token) {
      price = await getMoralisPrice(
        chain,
        wrapped_token.underlying,
        blockheight,
        global_token_info_debank,
        token_info,
        fastMode
      );
      if (MODE_SETTING === "dev") {
        console.log(
          `   Wrapped: ${token_info?.name || token}, Underlying: ${
            wrapped_token?.symbol
          }, Block, ${blockheight}, Price: ${price}`
        );
      }
    }
  }

  //Get Covalent price
  if (!price && token_info?.is_core && hierarchy_level > 1)
    price = await getCovalentPrice(
      chain,
      token,
      token_info?.optimized_symbol,
      block,
      wallet
    );
  return { price, token_info };
}

async function getTokenBalances(_chain, _address, _toBlock) {
  let options = {
    chain: _chain,
    address: _address,
  };
  if (_toBlock) options.to_block = _toBlock;
  try {
    // console.log('get token balances', Moralis.Web3API.account);
    const getTokenBalancesResult =
      await Moralis.Web3API.account.getTokenBalances(options);
    return getTokenBalancesResult;
  } catch (e) {
    console.log("get token balances error", e);
    throw e;
  }
}

async function getTokenTransfers(
  _chain,
  _tokenAddress,
  _result_max = TRANSACTION_MAX
) {
  let results = [];
  let tmpResults = [];
  let lastTransactionHash = '';
  let startBlock = 0;

  while(1) {
    const { data } = await axios.get(`${chainApis[_chain].serveUrl}api?module=account&action=tokentx&address=${_tokenAddress}&startblock=${startBlock}&endblock=latest&sort=asc&apikey=${chainApis[_chain].apiKey}`);

    if (data.status === '1' && data.message === 'OK') {
      const lastTransactionIdx = data.result.length - 1;
      const lastTransaction = data.result[lastTransactionIdx];

      if (lastTransactionHash === lastTransaction.hash) {
        tmpResults.push(...data.result);
        break;
      }

      startBlock = lastTransaction.blockNumber;
      lastTransactionHash = lastTransaction.hash;

      // Remove potentially duplicate transactions
      for (let i = lastTransactionIdx; i >= 0; i--) {
        if (data.result[i].blockNumber === startBlock) {
          data.result.pop();
        } else {
          break;
        }
      }

      tmpResults.push(...data.result);
    } else {
      break;
    }
  }

  tmpResults.map((result, index) => {
    let tmpResult = {};
    tmpResult.transaction_hash = result.hash;
    tmpResult.address = result.contractAddress;
    tmpResult.block_timestamp = new Date(Number(result.timeStamp) * 1000).toISOString();
    tmpResult.block_number = result.blockNumber;
    tmpResult.block_hash = result.blockHash;
    tmpResult.from_address = result.from;
    tmpResult.to_address = result.to;
    tmpResult.value = result.value;
    results.push(tmpResult);
  });

  results = removeDuplicates(results);
  
  return results;
}

async function getCurrentBlockNumber(_chain) {
  const tomorrow = new Date() + 1;
  // console.log('getCurrentBlockNumber::',_chain,tomorrow)
  const result = await Moralis.Web3API.native.getDateToBlock({
    chain: _chain,
    date: tomorrow,
  });
  // console.log('chain_result:',result)
  return result.block;
}

function flattenObj(history) {
  let result = [];
  for (var i = 0; i < history.length; i++) {
    result.push(history[i]);
    if (history[i].child) {
      const result_children = flattenObj(history[i].child);
      result.push(...result_children);
    }
  }
  return result;
}

async function getAssetsFromHistory(chain, history, global_balances_debank) {
  const flat_history = flattenObj(history);
  const liquid_assets = flat_history.filter((token) => token.valued_directly);
  let liquid_asset_ids = liquid_assets.map((token) => token.token_id);
  liquid_asset_ids = Array.from(new Set(liquid_asset_ids)); //de-dupe
  let assets = [];
  for (let i = 0; i < liquid_asset_ids.length; i++) {
    const token_info = await get_debank_token(
      chain,
      liquid_asset_ids[i],
      global_balances_debank
    );
    assets.push({
      id: token_info.id,
      ticker: token_info.optimized_symbol,
      logo: token_info?.logo_url || null,
    });
  }
  return assets;
}

function isEqualArray(array1, array2) {
  return JSON.stringify(array1) == JSON.stringify(array2);
}

function getDebankValue(
  tokenId,
  protocol,
  assets,
  global_complex_protocol_debank
) {
  const search_asset_ids = assets.map((asset) => asset.id).sort();
  const matching_position = global_complex_protocol_debank.filter(
    (position) => position.id == protocol.id //TODO: and chain must match
  )[0];
  if (typeof matching_position == "undefined") {
    return 0;
  }
  const pools = matching_position.portfolio_item_list;
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    if (!pool.detail.supply_token_list) continue;
    //For lending protocols, match on single supplied token, show token value
    if (pool.name == "Lending") {
      const lent_token = pool.detail.supply_token_list.find(
        (suptoken) => suptoken.id == search_asset_ids[0]
      );
      if (lent_token) return lent_token.price * lent_token.amount;
    }
    //For non-lending protocols, match on all supplied tokens, show LP value
    const pool_asset_ids = pool.detail?.supply_token_list
      .map((asset) => asset.id)
      .sort();
    if (isEqualArray(search_asset_ids, pool_asset_ids)) {
      return pool.stats.net_usd_value;
    }
  }
  return 0;
}

async function getCovalentPrice(
  chain,
  token_address,
  ticker_symbol,
  block,
  wallet
) {
  if (!block) {
    console.log("getCovalentPrice error: Need block for historical price");
    return null;
  }

  //Plan A: Token transfers endpoint
  try {
    const chainID = debank_chain_details[chain].community_id;
    const blockheight = block.block_number;
    const url = `https://api.covalenthq.com/v1/${chainID}/address/${wallet}/transfers_v2/?quote-currency=USD&format=JSON&contract-address=${token_address}&starting-block=${blockheight}&ending-block=${blockheight}&key=${covalent_key}`;
    const result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url: url,
    });
    const transfers = result.data.data.items[0].transfers;
    const relevant_transfer = transfers.find(
      (xfer) => xfer.contract_address == token_address
    );
    const result_price = relevant_transfer.quote_rate;
    return result_price;
  } catch (e) {
    console.log("Covalent price / transfers endpoint error:", e.response);
  }

  //Plan B: Historical price by symbol endpoint
  try {
    const block_date = moment(block.block_timestamp).format("YYYY-MM-DD");
    const url = `https://api.covalenthq.com/v1/pricing/historical/USD/${ticker_symbol}/?quote-currency=USD&format=JSON&from=${block_date}&to=${block_date}&key=${covalent_key}`;
    const result = await axios({
      method: "get",
      header: { "content-type": "application/json" },
      url: url,
    });
    const result_price = result.data.data.items[0].price;
    return result_price;
  } catch (e) {
    if (
      e.response &&
      e.response.data &&
      e.response.data.error_message &&
      e.response.data.error_message.includes("Ticker") &&
      e.response.data.error_message.includes(" not found")
    ) {
      console.log("getCovalentPrice:", `Ticker '${ticker_symbol}' not found.`);
    } else {
      console.log("Covalent price / symbol endpoint error:", e.response);
    }
  }

  return null;
}

function init() {
  Moralis.start(MORALLIS_SETTINGS)
    .then(async () => {
      console.log("Moralis Connected");
      {
        for (const chain in chainCoins) {
          const chainID = chainCoins[chain].chainId;
          try {
            const chainPrice = await LatestPriceNumber.findOne({
              chain: chainID,
            });
            latestBlockHeight[chain] = chainPrice.block_height;
          } catch (err) { }
        }
      }
      STATE.started = true;
      //setTimeout(() => updateMoralisPriceTable(), 600 * 1000);
    })
    .catch((e) => {
      console.log("moralis start error", e);
      // history = 'moralis start error';
      history = {
        message: "moralis start error",
        error: e,
      };
      // exit(1);
    });
}

async function retryMoralisFunc(moralisFunc, args, retryCnt = -1) {
  //console.log("Hello retryMoralisFunc", moralisFunc);
  let cnt = 0;
  while (retryCnt == -1 || cnt++ < retryCnt) {
    try {
      return await moralisFunc(...args);
    } catch (err) {
      const delayTime = Number(3000 + 4000 * Math.random()).toFixed(0);
      console.log(`Retrying Moralis func after ${delayTime} milisecond for`);
      await new Promise((resolve) => setTimeout(resolve, delayTime));
    }
  }
  return null;
}

module.exports = {
  STATE,
  init,
  getCurrentBlockNumber: async (...args) => {
    return await retryMoralisFunc(getCurrentBlockNumber, args, maxRetryCnt);
  },
  getTokenBalances: async (...args) => {
    return await retryMoralisFunc(getTokenBalances, args, maxRetryCnt);
  },
  getTokenTransfers: async (...args) => {
    return await retryMoralisFunc(getTokenTransfers, args, maxRetryCnt);
  },
  getTransactions: async (...args) => {
    return await retryMoralisFunc(getTransactions, args, maxRetryCnt);
  },
  getTokenMetadata: async (...args) => {
    return await retryMoralisFunc(getTokenMetadata, args, maxRetryCnt);
  },
  getTokenPrice,
  getOldTokenPrice,
  getAssetsFromHistory,
  getDebankValue,
  getCovalentPrice,
  latestBlockHeight,
};
