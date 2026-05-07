use sp1_sdk::{blocking::MockProver, blocking::Prover, include_elf, Elf, HashableKey, ProvingKey};

/// The ELF (executable and linkable format) file for the Succinct RISC-V zkVM.
const SIG_RECOVERY_ELF: Elf = include_elf!("sig-recovery-program");

fn main() {
    let prover = MockProver::new();
    let pk = prover.setup(SIG_RECOVERY_ELF).expect("failed to setup elf");
    println!("{}", pk.verifying_key().bytes32());
}
