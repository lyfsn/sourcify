import { Response, Request } from "express";
import {
  ContractWrapperMap,
  SendableContract,
  getSessionJSON,
  isVerifiable,
  verifyContractsInSession,
} from "../../verification.common";
import { isEmpty } from "@ethereum-sourcify/lib-sourcify";
import { BadRequestError } from "../../../../../common/errors";
import { services } from "../../../../services/services";
import logger from "../../../../../common/logger";

export async function verifyContractsInSessionEndpoint(
  req: Request,
  res: Response
) {
  const session = req.session;
  if (!session.contractWrappers || isEmpty(session.contractWrappers)) {
    throw new BadRequestError("There are currently no pending contracts.");
  }

  const receivedContracts: SendableContract[] = req.body.contracts;

  const requestId = req.headers["X-Request-ID"] || "";

  /* eslint-disable indent */
  logger.info("verifyContractsInSession", {
    requestId,
    receivedContracts: receivedContracts.map(
      ({ verificationId, chainId, address }) => ({
        verificationId,
        chainId,
        address,
      })
    ),
  });
  /* eslint-enable indent*/

  const verifiable: ContractWrapperMap = {};
  for (const receivedContract of receivedContracts) {
    const id = receivedContract.verificationId;
    const contractWrapper = session.contractWrappers[id];
    if (contractWrapper) {
      contractWrapper.address = receivedContract.address;
      contractWrapper.chainId = receivedContract.chainId;
      /* contractWrapper.contextVariables = receivedContract.contextVariables; */
      contractWrapper.creatorTxHash = receivedContract.creatorTxHash;
      if (isVerifiable(contractWrapper)) {
        verifiable[id] = contractWrapper;
      }
    }
  }

  await verifyContractsInSession(
    verifiable,
    session,
    services.verification,
    services.storage
  );
  res.send(getSessionJSON(session));
}
