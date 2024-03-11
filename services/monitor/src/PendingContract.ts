import logger from "./logger";
import { FileHash } from "./util";
import { Metadata, MetadataSourceMap } from "@ethereum-sourcify/lib-sourcify";
import { id as keccak256str } from "ethers";
import { KnownDecentralizedStorageFetchers } from "./types";
import assert from "assert";
import dotenv from "dotenv";
import nodeFetch from "node-fetch";
import { Logger } from "winston";

dotenv.config();

export default class PendingContract {
  public metadataHash: FileHash;
  public address: string;
  public chainId: number;
  public metadata: Metadata | undefined;
  public pendingSources: MetadataSourceMap = {};
  public fetchedSources: MetadataSourceMap = {};
  private decentralizedStorageFetchers: KnownDecentralizedStorageFetchers;
  private contractLogger: Logger = logger.child({
    moduleName: "PendingContract",
  });

  constructor(
    metadataHash: FileHash,
    address: string,
    chainId: number,
    decentralizedStorageFetchers: KnownDecentralizedStorageFetchers
  ) {
    this.metadataHash = metadataHash;
    this.address = address;
    this.chainId = chainId;
    this.decentralizedStorageFetchers = decentralizedStorageFetchers;
  }

  /**
   * Assembles this contract by first fetching its metadata and then fetching all the sources listed in the metadata.
   */
  assemble = async () => {
    const metadataFetcher =
      this.decentralizedStorageFetchers[this.metadataHash.origin];
    if (!metadataFetcher) {
      throw new Error(
        `No metadata fetcher found origin=${this.metadataHash.origin}`
      );
    }
    const metadataStr = await metadataFetcher
      .fetch(this.metadataHash)
      .catch((err) => {
        throw new Error(
          `Can't fetch metadata address=${this.address} hash=${this.metadataHash.hash} origin=${this.metadataHash.origin}: ${err}`
        );
      });
    this.contractLogger.info("[PendingContract.assemble] Fetched metadata", {
      metadataHash: this.metadataHash,
      address: this.address,
      chainId: this.chainId,
      origin: this.metadataHash.origin,
    });
    this.metadata = JSON.parse(metadataStr) as Metadata;
    // TODO: use structuredClone of Node v17+ instead of JSON.parse(JSON.stringify()) after upgrading
    this.pendingSources = JSON.parse(JSON.stringify(this.metadata.sources)); // Copy, don't mutate original.

    // Try to fetch all sources in parallel.
    const fetchPromises = Object.keys(this.pendingSources).map(
      async (sourceUnitName) => {
        const source = this.pendingSources[sourceUnitName];

        // Source already inline.
        if (source.content) {
          this.contractLogger.info(
            "[PendingContract.assemble] Source has inline content",
            {
              sourceUnitName,
              address: this.address,
              chainId: this.chainId,
            }
          );
          this.movePendingToFetchedSources(sourceUnitName);
          return;
        }

        let fetchedContent: string | undefined;
        // There are multiple urls. Can be fetched from any of them.
        // TODO: Can url be https:// ?
        for (const url of source.urls || []) {
          const fileHash = FileHash.fromUrl(url);
          if (!fileHash) {
            this.contractLogger.info(
              "[PendingContract.assemble] No hash found for url",
              {
                url,
                address: this.address,
                chainId: this.chainId,
              }
            );
            continue;
          }
          const fetcher = this.decentralizedStorageFetchers[fileHash.origin];
          if (!fetcher) {
            this.contractLogger.debug(
              "[PendingContract.assemble] No fetcher found for origin",
              {
                fileHash,
                address: this.address,
                chainId: this.chainId,
              }
            );
            continue;
          }
          fetchedContent = await fetcher.fetch(fileHash);
          this.contractLogger.info(
            "[PendingContract.assemble] Fetched source",
            {
              sourceUnitName,
              address: this.address,
              chainId: this.chainId,
              fileHash,
            }
          );
          source.content = fetchedContent;
          this.movePendingToFetchedSources(sourceUnitName);
        }
      }
    );
    return Promise.all(fetchPromises);
  };

  public sendToSourcifyServer = async (
    sourcifyServerURL: string,
    creatorTxHash?: string
  ): Promise<any> => {
    // format in { "source1.sol": "Contract A { ...}", "source2.sol": "Contract B { ...}" } format
    const formattedSources: { [key: string]: string } = {};
    for (const sourceUnitName of Object.keys(this.fetchedSources)) {
      const source = this.fetchedSources[sourceUnitName];
      if (!source.content)
        throw new Error(
          `Unexpectedly empty source content when sending to Sourcify server. Contract ${this.address} on chain ${this.chainId}`
        );
      formattedSources[sourceUnitName] = source.content;
    }

    // Send to Sourcify server.
    const response = await nodeFetch(sourcifyServerURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sourcify-monitor",
      },
      body: JSON.stringify({
        chainId: this.chainId.toString(),
        address: this.address,
        files: {
          ...formattedSources,
          "metadata.json": JSON.stringify(this.metadata),
        },
        creatorTxHash,
      }),
    });

    if (response.status === 200) {
      this.contractLogger.info(
        "[PendingContract.sendToSourcifyServer] Contract sent",
        {
          address: this.address,
          chainId: this.chainId,
          sourcifyServerURL,
        }
      );
      return response.json();
    } else {
      throw new Error(
        `Error sending contract ${
          this.address
        } to Sourcify server ${sourcifyServerURL}: ${
          response.statusText
        } ${await response.text()}`
      );
    }
  };

  private movePendingToFetchedSources = (sourceUnitName: string) => {
    const source = this.pendingSources[sourceUnitName];
    if (!source) {
      throw new Error(`Source ${sourceUnitName} not found`);
    }
    if (!source.content) {
      throw new Error(`Source ${sourceUnitName} has no content`);
    }
    const calculatedKeccak = keccak256str(source.content);
    assert(
      calculatedKeccak === source.keccak256,
      `Keccak mismatch for ${sourceUnitName}`
    );

    this.fetchedSources[sourceUnitName] = { ...source };
    delete this.pendingSources[sourceUnitName];
  };
}
