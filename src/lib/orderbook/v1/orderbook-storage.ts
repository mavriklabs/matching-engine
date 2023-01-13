import { Redis } from 'ioredis';

import { ChainId } from '@infinityxyz/lib/types/core';

import { logger } from '@/common/logger';

import { AbstractOrderbookStorage } from '../orderbook-storage.abstract';
import { Order } from './order';
import { OrderData } from './types';

export class OrderbookStorage extends AbstractOrderbookStorage<Order, OrderData> {
  public readonly version = 'v1';

  /**
   * a set of all match ids for an order
   */
  getOrderMatchesSet(orderId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${orderId}`;
  }

  /**
   * an ordered set of order ids that are
   * ordered by the matches max gas price
   */
  get matchesByGasPriceOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:by-gas-price`;
  }

  /**
   * key value pairs of a match id to a full match
   */
  getFullMatchKey(matchId: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:order-matches:${matchId}:full`;
  }

  get storedOrdersSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:orders`;
  }

  get activeOrdersOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-status:active`;
  }

  get executedOrdersOrderedSetKey() {
    return `orderbook:${this.version}:chain:${this._chainId}:order-status:executed`;
  }

  getOrderId(order: Order): string {
    return order.id;
  }

  getTokenListingsSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getTokenOffersSet(constraints: { complication: string; currency: string; collection: string; tokenId: string }) {
    const scope = 'token-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}:tokenId:${constraints.tokenId}`;
  }

  getCollectionTokenListingsSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-token-orders';
    const side = 'sell';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  getFullOrderKey(id: string) {
    return `orderbook:${this.version}:chain:${this._chainId}:orders:${id}:full`;
  }

  getCollectionTokenOffersSet(constraints: {
    complication: string;
    currency: string;
    collection: string;
    tokenId: string;
  }) {
    const scope = 'collection-token-orders';
    const side = 'buy';

    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  getCollectionWideOffersSet(constraints: { complication: string; currency: string; collection: string }) {
    const scope = 'collection-wide-orders';
    const side = 'buy';
    return `scope:${scope}:complication:${constraints.complication}:side:${side}:collection:${constraints.collection}`;
  }

  constructor(protected _db: Redis, protected _chainId: ChainId) {
    super();
  }

  async has(orderId: string): Promise<boolean> {
    const result = await this._db.sismember(this.storedOrdersSetKey, orderId);
    return result === 1;
  }

  async save(_items: OrderData | OrderData[]): Promise<void> {
    const items = Array.isArray(_items) ? _items : [_items];

    for (const item of items) {
      try {
        let txn = this._db.multi();

        const order = new Order(Order.getOrderParams(item.id, this._chainId, item.order));
        const orderItemSets = this._getOrderItemSets(order);
        const fullOrder = JSON.stringify(item);
        if (item.status === 'active') {
          logger.log('orderbook-storage', `Adding order ${item.id} to active orders`);
          txn = txn.sadd(this.storedOrdersSetKey, item.id).zadd(this.activeOrdersOrderedSetKey, -1, item.id);
          txn = txn.set(this.getFullOrderKey(item.id), fullOrder);

          for (const set of orderItemSets.sets) {
            txn = txn.zadd(set, orderItemSets.orderScore, item.id);
          }
        } else {
          logger.log('orderbook-storage', `Removing order ${item.id} from active orders`);
          txn.srem(this.storedOrdersSetKey, item.id).zrem(this.activeOrdersOrderedSetKey, item.id);
          txn.del(this.getFullOrderKey(item.id));

          for (const set of orderItemSets.sets) {
            txn.zrem(set, item.id);
          }
          /**
           * delete the set,
           * for every order match in the set, delete the full match
           */
          const orderMatchesSet = this.getOrderMatchesSet(item.id);
          const matches = await this._db.smembers(orderMatchesSet);

          if (matches.length > 0) {
            logger.log('orderbook-storage', `Removing matches: ${matches.join(', \n')} for order ${item.id}`);
            txn.del(matches.map(this.getFullMatchKey.bind(this)));
            txn.zrem(this.matchesByGasPriceOrderedSetKey, ...matches);
            for (const match of matches) {
              const matchOrderMatchesSet = this.getOrderMatchesSet(match);
              txn.srem(matchOrderMatchesSet, item.id);
            }
          }
          txn.del(orderMatchesSet);
        }
        const results = await txn.exec();
        if (results) {
          for (const [error] of results) {
            if (error) {
              logger.error('orderbook-storage', `Failed to save order ${item.id} - ${item.status} ${error}`);
            }
          }
        }

        logger.log('orderbook-storage', `Handled order ${item.id}`);
      } catch (err) {
        logger.error('orderbook-storage', `Failed to save order event ${item.id} - ${item.status} ${err}`);
      }
    }
  }

  protected _getOrderItemSets(order: Order) {
    const orderItem = order.getOrderItem();

    const sets: string[] = [];

    switch (`${order.params.side}:${'tokenId' in orderItem ? 'token' : 'collection'}`) {
      case 'buy:token': {
        const tokenId = (orderItem as { collection: string; tokenId: string }).tokenId;
        const tokenOffers = this.getTokenOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });
        const tokenCollectionOffers = this.getCollectionTokenOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });

        sets.push(tokenOffers, tokenCollectionOffers);
        break;
      }
      case 'buy:collection': {
        const collectionWideOffers = this.getCollectionWideOffersSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection
        });
        sets.push(collectionWideOffers);
        break;
      }
      case 'sell:token': {
        const tokenId = (orderItem as { collection: string; tokenId: string }).tokenId;

        const tokenSells = this.getTokenListingsSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection,
          tokenId
        });
        const tokenCollectionSells = this.getCollectionTokenListingsSet({
          complication: order.params.complication,
          currency: order.params.currency,
          collection: orderItem.collection
        });
        sets.push(tokenSells, tokenCollectionSells);
        break;
      }
      case 'sell:collection': {
        throw new Error('Unsupported order side');
      }
    }

    const orderScore = order.params.startPriceEth;

    return { sets, orderScore };
  }
}
