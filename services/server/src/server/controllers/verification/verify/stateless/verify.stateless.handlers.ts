import { Response } from "express";
import { services } from "../../../../services/services";
import {
  LegacyVerifyRequest,
  extractFiles,
  solc,
  stringifyInvalidAndMissing,
} from "../../verification.common";
import {
  CheckedContract,
  checkFiles,
  useAllSources,
} from "@ethereum-sourcify/lib-sourcify";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../../../../common/errors";
import { StatusCodes } from "http-status-codes";
import { getResponseMatchFromMatch } from "../../../../common";
import logger from "../../../../../common/logger";

export async function legacyVerifyEndpoint(
  req: LegacyVerifyRequest,
  res: Response
): Promise<any> {
  const result = await services.storage.checkByChainAndAddress(
    req.body.address,
    req.body.chain
  );
  if (result.length != 0) {
    return res.send({ result: [getResponseMatchFromMatch(result[0])] });
  }

  const inputFiles = extractFiles(req);
  if (!inputFiles) {
    const msg =
      "Couldn't extract files from the request. Please make sure you have added files";
    throw new NotFoundError(msg);
  }

  let checkedContracts: CheckedContract[];
  try {
    checkedContracts = await checkFiles(solc, inputFiles);
  } catch (error: any) {
    throw new BadRequestError(error.message);
  }

  const errors = checkedContracts
    .filter((contract) => !CheckedContract.isValid(contract, true))
    .map(stringifyInvalidAndMissing);
  if (errors.length) {
    throw new BadRequestError(
      "Invalid or missing sources in:\n" + errors.join("\n")
    );
  }

  if (checkedContracts.length !== 1 && !req.body.chosenContract) {
    const contractNames = checkedContracts.map((c) => c.name).join(", ");
    const msg = `Detected ${checkedContracts.length} contracts (${contractNames}), but can only verify 1 at a time. Please choose a main contract and click Verify again.`;
    const contractsToChoose = checkedContracts.map((contract) => ({
      name: contract.name,
      path: contract.compiledPath,
    }));
    return res
      .status(StatusCodes.BAD_REQUEST)
      .send({ error: msg, contractsToChoose });
  }

  const contract: CheckedContract = req.body.chosenContract
    ? checkedContracts[req.body.chosenContract]
    : checkedContracts[0];

  try {
    const match = await services.verification.verifyDeployed(
      contract,
      req.body.chain,
      req.body.address,
      /* req.body.contextVariables, */
      req.body.creatorTxHash
    );
    // Send to verification again with all source files.
    if (match.runtimeMatch === "extra-file-input-bug") {
      logger.info("Found extra-file-input-bug", {
        contract: contract.name,
        chain: req.body.chain,
        address: req.body.address,
      });
      const contractWithAllSources = await useAllSources(contract, inputFiles);
      const tempMatch = await services.verification.verifyDeployed(
        contractWithAllSources,
        req.body.chain,
        req.body.address,
        req.body.creatorTxHash
      );
      if (
        tempMatch.runtimeMatch === "perfect" ||
        tempMatch.creationMatch === "perfect"
      ) {
        await services.storage.storeMatch(contract, tempMatch);
        return res.send({ result: [getResponseMatchFromMatch(tempMatch)] });
      } else if (tempMatch.runtimeMatch === "extra-file-input-bug") {
        throw new ValidationError(
          "It seems your contract's metadata hashes match but not the bytecodes. You should add all the files input to the compiler during compilation and remove all others. See the issue for more information: https://github.com/ethereum/sourcify/issues/618"
        );
      }
    }
    if (match.runtimeMatch || match.creationMatch) {
      await services.storage.storeMatch(contract, match);
    }
    return res.send({ result: [getResponseMatchFromMatch(match)] }); // array is an old expected behavior (e.g. by frontend)
  } catch (error: any) {
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .send({ error: error.message });
  }
}
