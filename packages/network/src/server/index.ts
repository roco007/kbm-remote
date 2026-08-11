/**
 * WSS gateway host (receiver-side) barrel.
 */

export {
  WssGateway,
  type GatewaySession,
  type GatewayState,
  type WssGatewayOptions,
  DEFAULT_MAX_FRAME_BYTES,
} from "./WssGateway";
export {
  FrameRouter,
  PRE_AUTH_TYPES,
  type FrameContext,
  type FrameHandler,
  type RouteOutcome,
  handlerSuccess,
} from "./frameRouter";
export { FrameHandlerError, type HandlerResult } from "./gatewayTypes";
export {
  AuthMiddleware,
  type AuthDependencies,
  type AuthDecision,
  type AuthStore,
} from "./authMiddleware";
