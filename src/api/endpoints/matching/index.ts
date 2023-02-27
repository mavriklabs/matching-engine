import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';
import PQueue from 'p-queue';

import { logger } from '@/common/logger';
import { config } from '@/config';
import { getOrderbook, getProcesses, startCollection } from '@/lib/collections-queue/start-collection';

const base = '/matching';

export default async function register(fastify: FastifyInstance) {
  /**
   * get the status of the matching engine for a collection
   */
  fastify.get(`${base}/collection/:collection`, async (request) => {
    const _collection =
      typeof request.params == 'object' &&
      request.params &&
      'collection' in request.params &&
      typeof request.params.collection === 'string'
        ? request.params.collection
        : '';

    if (!ethers.utils.isAddress(_collection)) {
      throw new Error('Invalid collection address');
    }
    const collection = _collection.toLowerCase();

    const processes = getProcesses(collection);

    const matchingEngineJobsProcessing = await processes.matchingEngine.queue.count();
    const matchingEngineJobCounts = await processes.matchingEngine.queue.getJobCounts();

    const orderRelayJobsProcessing = await processes.orderRelay.queue.count();
    const orderRelayJobCounts = await processes.orderRelay.queue.getJobCounts();

    const matchingEngineHealthPromise = processes.matchingEngine.checkHealth();
    const orderRelayHealthPromise = processes.orderRelay.checkHealth();

    const [matchingEngineHealth, orderRelayHealth] = await Promise.all([
      matchingEngineHealthPromise,
      orderRelayHealthPromise
    ]);

    await processes.matchingEngine.close();
    await processes.orderRelay.close();

    return {
      isSynced: orderRelayJobCounts.waiting < 500 && matchingEngineJobCounts.waiting < 500,
      matchingEngine: {
        healthStatus: matchingEngineHealth,
        jobsProcessing: matchingEngineJobsProcessing,
        jobCounts: matchingEngineJobCounts
      },
      orderRelay: {
        healthStatus: orderRelayHealth,
        jobsProcessing: orderRelayJobsProcessing,
        jobCounts: orderRelayJobCounts
      }
    };
  });

  if (!config.components.api.readonly) {
    /**
     * start the matching engine for a collection
     */
    fastify.put(`${base}/collection/:collection`, (request) => {
      const _collection =
        typeof request.params == 'object' &&
        request.params &&
        'collection' in request.params &&
        typeof request.params.collection === 'string'
          ? request.params.collection
          : '';

      if (!ethers.utils.isAddress(_collection)) {
        throw new Error('Invalid collection address');
      }
      const collection = _collection.toLowerCase();

      startCollection(collection).catch((err) => {
        logger.error(`PUT ${base}/:collection`, `Failed to start collection ${collection} ${JSON.stringify(err)}`);
      });

      return { status: 'ok' };
    });
  }
  fastify.get(`${base}/order/:order`, async (request) => {
    const orderId =
      typeof request.params == 'object' &&
      request.params &&
      'order' in request.params &&
      typeof request.params.order === 'string'
        ? request.params.order
        : '';

    if (!ethers.utils.isHexString(orderId)) {
      throw new Error('Invalid order hash');
    }

    const { orderbookStorage } = getOrderbook();

    const status = await orderbookStorage.getExecutionStatus(orderId, orderbookStorage);
    return {
      status
    };
  });

  fastify.post(`${base}/orders`, async (request) => {
    const orderIds =
      typeof request.body == 'object' && request.body && 'orders' in request.body && Array.isArray(request.body.orders)
        ? request.body.orders
        : [];

    for (const orderId of orderIds) {
      if (typeof orderId !== 'string' || !ethers.utils.isHexString(orderId)) {
        throw new Error('Invalid order hash');
      }
    }
    const { orderbookStorage } = getOrderbook();

    const queue = new PQueue({ concurrency: 20 });

    const statuses = orderIds.map(async (orderId: string) => {
      return await queue.add(async () => {
        return await orderbookStorage.getExecutionStatus(orderId, orderbookStorage);
      });
    });

    return {
      data: await Promise.all(statuses)
    };
  });

  /**
   * trigger the matching engine to match orders
   */

  if (!config.components.api.readonly) {
    fastify.put(`${base}/order/:order`, async (request) => {
      const orderId =
        typeof request.params == 'object' &&
        request.params &&
        'order' in request.params &&
        typeof request.params.order === 'string'
          ? request.params.order
          : '';

      if (!ethers.utils.isHexString(orderId)) {
        throw new Error('Invalid order hash');
      }

      const { orderbookStorage } = getOrderbook();

      const status = await orderbookStorage.getStatus(orderId);

      if (status !== 'active') {
        return {
          success: false,
          reason: 'order is not active'
        };
      }

      const order = await orderbookStorage.getOrder(orderId);
      if (!order) {
        return {
          success: false,
          reason: 'failed to find order'
        };
      }

      const collections = orderbookStorage.getOrderCollections(order);
      const orderParams = orderbookStorage.getOrderParams(order);
      const collection = collections[0];
      if (collections.length !== 1) {
        logger.error(`PUT ${base}/order/:order`, `Order ${orderId} has multiple collections`);
        return {
          success: false,
          reason: 'order has multiple collections'
        };
      }

      const processes = getProcesses(collection);
      await processes.matchingEngine.add({ id: orderId, order: orderParams, proposerInitiatedAt: Date.now() });
      await processes.matchingEngine.close();
      await processes.orderRelay.close();

      return {
        success: true
      };
    });
  }

  await Promise.resolve();
}
