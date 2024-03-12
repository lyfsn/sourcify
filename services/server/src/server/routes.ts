import { Router } from "express"; // static is a reserved word
import testArtifactsRoutes from "./controllers/testartifacts/testartifacts.routes";
import repositoryRoutes from "./controllers/repository/repository.routes";
import sessionStateRoutes from "./controllers/verification/session-state/session-state.routes";
import verifyRoutes from "./controllers/verification/verify/verify.routes";
import solcJsonRoutes from "./controllers/verification/solc-json/solc-json.routes";
import etherscanRoutes from "./controllers/verification/etherscan/etherscan.routes";
import { sourcifyChainsArray } from "../sourcify-chains";
import serverLoggerInstance, { setLogLevel } from "../common/logger";

const router: Router = Router();

router.use("/chain-tests", testArtifactsRoutes);

router.get("/health", (_req, res) =>
  res.status(200).send("Alive and kicking!")
);

// Authenticated route to change the logging level.
// Authentication handled by the express-openapi-validator middleware
router.post("/change-log-level", (req, res) => {
  console.log("Secure: " + req.secure);
  const { level } = req.body;
  try {
    setLogLevel(level);
    res.status(200).send(`Logging level changed to: ${level}`);
  } catch (error) {
    serverLoggerInstance.error({
      message: "Failed to change logging level",
      error,
    });
    res.status(500).send("Failed to change logging level: " + error);
  }
});

router.get("/chains", (_req, res) => {
  const sourcifyChains = sourcifyChainsArray.map(
    ({ rpc, name, title, chainId, supported, etherscanApi }) => {
      // Don't publish providers
      // Don't show Alchemy & Infura IDs
      rpc = rpc.map((url) => {
        if (typeof url === "string") {
          if (url.includes("alchemy"))
            return url.replace(/\/[^/]*$/, "/{ALCHEMY_API_KEY}");
          else if (url.includes("infura"))
            return url.replace(/\/[^/]*$/, "/{INFURA_API_KEY}");
          else return url;
        } else {
          // FetchRequest
          return url.url;
        }
      });
      return {
        name,
        title,
        chainId,
        rpc,
        supported,
        etherscanAPI: etherscanApi?.apiURL, // Needed in the UI
      };
    }
  );

  res.status(200).json(sourcifyChains);
});

router.use("/", repositoryRoutes);

router.use("/", sessionStateRoutes);
router.use("/", verifyRoutes);
router.use("/", solcJsonRoutes);
router.use("/", etherscanRoutes);

export default router;
