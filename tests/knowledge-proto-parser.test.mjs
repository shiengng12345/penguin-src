import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProtoEndpoints } from "../packages/knowledge-indexer/dist/index.js";

test("proto parser extracts every RPC when methods have bodies and nested options", () => {
  const source = `
    syntax = "proto3";
    service RoomService {
      rpc createRoom (CreateRoomRequest) returns (CreateRoomResponse) {}
      rpc joinRoom (JoinRoomRequest) returns (JoinRoomResponse) {}
      rpc leaveRoom (LeaveRoomRequest) returns (LeaveRoomResponse) {}
      rpc inviteUser (InviteUserRequest) returns (InviteUserResponse) {}
    }
    service FrontendRecommendService {
      rpc SearchGames(SearchGamesReq) returns (SearchGamesRes) {
        option deprecated = true;
      }
      rpc Search(SearchReq) returns (SearchRes);
    }
  `;

  const endpoints = parseProtoEndpoints(source, "apps/test/service.proto");
  assert.deepEqual(
    endpoints.map(({ service, method }) => `${service}.${method}`),
    [
      "RoomService.createRoom",
      "RoomService.joinRoom",
      "RoomService.leaveRoom",
      "RoomService.inviteUser",
      "FrontendRecommendService.SearchGames",
      "FrontendRecommendService.Search",
    ],
  );
});
