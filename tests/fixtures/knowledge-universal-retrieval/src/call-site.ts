export async function invokeCpfLookup(
  playerAdditionalDetailRepository: {
    findAllByCpf(input: { cpf: string }): Promise<unknown>;
  },
  cpf: string,
): Promise<unknown> {
  // 入口日志只记 platformId,绝不回显明文 cpf(PII)
  return playerAdditionalDetailRepository.findAllByCpf({ cpf });
}
