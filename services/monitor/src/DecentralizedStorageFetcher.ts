import { FileHash } from "./util";
import logger from "./logger";
import {
  DecentralizedStorageConfig,
  DecentralizedStorageOrigin,
} from "./types";
import assert from "assert";
import { EventEmitter } from "stream";
import { GatewayFetcher } from "./GatewayFetcher";
import defaultConfig from "./defaultConfig";
import { Logger } from "winston";

/**
 * Fetcher for a certain type of Decentralized Storage (e.g. IPFS)
 * Will try to fetch from multiple gateways.
 */
export default class DecentralizedStorageFetcher extends EventEmitter {
  // TODO: Run local js-ipfs instead of using gateways??
  public origin: DecentralizedStorageOrigin;
  private gatewayFetchers: GatewayFetcher[];

  // A file can be requested for multiple contracts. We only want to fetch it once. This mapping keeps track of the number of unique files.
  private uniqueFiles: { [key: string]: boolean } = {};
  // Counter to keep track of the number of unique files. Used for logging.
  private uniqueFilesCounter = 0;

  // A file can be requested by multiple contracts. This counter keeps track of the number of subscribers, i.e. contracts that want to receive a file. Used for logging.
  private subcriberCounter = 0;
  private storageFetcherLogger: Logger;

  constructor(
    origin: DecentralizedStorageOrigin,
    decentralizedStorageConfig: DecentralizedStorageConfig
  ) {
    super();
    this.origin = origin;
    this.storageFetcherLogger = logger.child({
      moduleName: "DecentralizedStorageFetcher " + origin,
    });
    this.gatewayFetchers = decentralizedStorageConfig.gateways.map(
      (gatewayURL) =>
        new GatewayFetcher({
          url: gatewayURL,
          fetchTimeout:
            decentralizedStorageConfig.timeout ||
            defaultConfig.decentralizedStorages.ipfs.timeout,
          fetchInterval:
            decentralizedStorageConfig.interval ||
            defaultConfig.decentralizedStorages.ipfs.interval,
          fetchRetries:
            decentralizedStorageConfig.retries ||
            defaultConfig.decentralizedStorages.ipfs.retries,
        })
    );
  }

  fetch = (fileHash: FileHash) => {
    assert(fileHash.origin === this.origin, "Invalid origin");

    return new Promise<string>((resolve, reject) => {
      const cleanupSubscription = () => {
        this.subcriberCounter--;
        if (this.uniqueFiles[fileHash.hash]) {
          this.uniqueFilesCounter--;
          delete this.uniqueFiles[fileHash.hash];
        }
        this.removeListener(`${fileHash.hash} fetched`, successListener);
        this.removeListener(`${fileHash.hash} fetch failed`, failListener);
        this.storageFetcherLogger.info("Removed file listener", {
          fileHash,
          origin: this.origin,
          subscriberCounter: this.subcriberCounter,
          uniqueFilesCounter: this.uniqueFilesCounter,
        });
      };

      // Only resolve on success or failure
      const successListener = (file: string) => {
        cleanupSubscription();
        resolve(file);
      };

      const failListener = () => {
        cleanupSubscription();
        reject(`Failed to fetch ${fileHash.hash} from ${this.origin}`);
      };

      // Subscribe to fetching of the file.
      this.on(`${fileHash.hash} fetched`, successListener);
      // Subscribe to failure of fetching the file.
      this.on(`${fileHash.hash} fetch failed`, failListener);

      // Need the file for the first time.
      if (!this.uniqueFiles[fileHash.hash]) {
        this.uniqueFiles[fileHash.hash] = true;
        this.subcriberCounter++;
        this.uniqueFilesCounter++;

        this.tryGatewaysSequentially(fileHash);
      }
      // Already trying to fetch this file. Don't fetch again.
      // The event listener for when the file is fetches is already added above.
      else {
        this.subcriberCounter++;
        this.storageFetcherLogger.info("Fetch already exists", {
          fileHash,
          origin: this.origin,
          subscriberCounter: this.subcriberCounter,
          uniqueFilesCounter: this.uniqueFilesCounter,
        });
      }
    });
  };

  // Try to fetch the file from all gateways sequentially.
  // If a fetch from a gateway times out, don't try others. Probably the file is not pinned.
  // If a fetch from a gateway fails for another reason, try the next gateway.
  tryGatewaysSequentially = async (fileHash: FileHash) => {
    this.storageFetcherLogger.debug("tryGatewaysSequentially", {
      fileHash,
      gateways: this.gatewayFetchers.map((gw) => gw.url),
    });
    for (let gwIndex = 0; gwIndex < this.gatewayFetchers.length; gwIndex++) {
      const gatewayFetcher = this.gatewayFetchers[gwIndex];
      this.storageFetcherLogger.info("Fetching from gateway", {
        fileHash,
        origin: this.origin,
        subscriberCounter: this.subcriberCounter,
        uniqueFilesCounter: this.uniqueFilesCounter,
      });
      try {
        const file = await gatewayFetcher.fetchWithRetries(fileHash.hash);
        this.storageFetcherLogger.info("Fetched from gateway", {
          fileHash,
          origin: this.origin,
          subscriberCounter: this.subcriberCounter,
          uniqueFilesCounter: this.uniqueFilesCounter,
        });
        // Log if we had to use a fallback gateway
        if (gwIndex > 0) {
          this.storageFetcherLogger.info("Used FallbackGateway", {
            fileHash,
            gatewayFetcherUrl: gatewayFetcher.url,
          });
        }
        // Notify the subscribers
        this.emit(`${fileHash.hash} fetched`, file);
        return;
      } catch (err: any) {
        if (err.timeout) {
          this.storageFetcherLogger.info("Timeout fetching from gateway", {
            fileHash,
            gatewayFetcherUrl: gatewayFetcher.url,
            err,
          });
        } else {
          // Something's wront with the GW. Use fallback
          this.storageFetcherLogger.error("Error fetching from gateway", {
            fileHash,
            gatewayFetcherUrl: gatewayFetcher.url,
            err,
          });
        }
      }
    }
    this.storageFetcherLogger.info("Couldn't fetch from any gateways", {
      fileHash,
      gateways: this.gatewayFetchers.map((gw) => gw.url),
    });
    this.emit(`${fileHash.hash} fetch failed`);
  };
}
