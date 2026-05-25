/**
 * devices.ts
 * ----------------------------------------------------------------------------
 * Curated list of common FPGA parts surfaced in the project wizard's
 * device picker. Each entry's `value` is the exact part string passed
 * verbatim to vendor Tcl (Vivado `synth_design -part`, Quartus DEVICE
 * assignment); the `label` is what shows in the dropdown.
 *
 * The wizard's combobox runs in `creatable` mode, so a user with a part
 * not in this catalog can still type their own string and accept it.
 * Keep this list focused on popular dev-board parts rather than trying
 * to enumerate every SKU.
 */

export interface DeviceOption {
    /** Exact part string passed to vendor tooling. */
    value: string;
    /** Human-friendly label shown in the dropdown. */
    label: string;
}

export const XILINX_DEVICES: DeviceOption[] = [
    // Spartan-7
    { value: "xc7s6cpga196-1",      label: "Spartan-7 XC7S6 (CPGA196) — entry-level" },
    { value: "xc7s15cpga196-1",     label: "Spartan-7 XC7S15 (CPGA196)" },
    { value: "xc7s25csga324-1",     label: "Spartan-7 XC7S25 (CSGA324)" },
    { value: "xc7s50csga324-1",     label: "Spartan-7 XC7S50 (CSGA324)" },

    // Artix-7
    { value: "xc7a35tcpg236-1",     label: "Artix-7 XC7A35T (CPG236) — Basys 3" },
    { value: "xc7a35ticsg324-1L",   label: "Artix-7 XC7A35TI (CSG324) — Arty A7-35T" },
    { value: "xc7a50tcsg324-1",     label: "Artix-7 XC7A50T (CSG324)" },
    { value: "xc7a100tcsg324-1",    label: "Artix-7 XC7A100T (CSG324) — Nexys A7-100T / Arty A7-100T" },
    { value: "xc7a200tffg1156-1",   label: "Artix-7 XC7A200T (FFG1156)" },

    // Kintex-7
    { value: "xc7k70tfbg484-1",     label: "Kintex-7 XC7K70T (FBG484)" },
    { value: "xc7k160tffg676-1",    label: "Kintex-7 XC7K160T (FFG676)" },
    { value: "xc7k325tffg676-1",    label: "Kintex-7 XC7K325T (FFG676) — KC705" },
    { value: "xc7k410tffg676-1",    label: "Kintex-7 XC7K410T (FFG676)" },

    // Virtex-7
    { value: "xc7v585tffg1761-1",   label: "Virtex-7 XC7V585T (FFG1761)" },

    // Zynq-7000
    { value: "xc7z010clg400-1",     label: "Zynq-7000 XC7Z010 (CLG400) — Zybo Z7-10" },
    { value: "xc7z020clg400-1",     label: "Zynq-7000 XC7Z020 (CLG400) — Zybo Z7-20" },
    { value: "xc7z020clg484-1",     label: "Zynq-7000 XC7Z020 (CLG484) — ZedBoard / PYNQ-Z1" },
    { value: "xc7z030sbg485-1",     label: "Zynq-7000 XC7Z030 (SBG485)" },

    // Zynq UltraScale+
    { value: "xczu3eg-sbva484-1-e", label: "Zynq US+ XCZU3EG (SBVA484) — Ultra96-V2" },
    { value: "xczu7ev-ffvc1156-2-e",label: "Zynq US+ XCZU7EV (FFVC1156) — ZCU104" },
    { value: "xczu9eg-ffvb1156-2-e",label: "Zynq US+ XCZU9EG (FFVB1156) — ZCU102" },

    // Kintex UltraScale / UltraScale+
    { value: "xcku040-ffva1156-2-e",label: "Kintex US XCKU040 (FFVA1156) — KCU105" },
    { value: "xcku115-flva1517-2-e",label: "Kintex US XCKU115 (FLVA1517)" },

    // Virtex UltraScale+
    { value: "xcvu9p-flga2104-2-e", label: "Virtex US+ XCVU9P (FLGA2104) — VCU118" },

    // Versal
    { value: "xcvc1902-vsva2197-2MP-e-S", label: "Versal VC1902 (VSVA2197) — VCK190" },
];

export const INTEL_DEVICES: DeviceOption[] = [
    // Cyclone IV E / GX
    { value: "EP4CE6E22C8",         label: "Cyclone IV E EP4CE6 (E22)" },
    { value: "EP4CE10E22C8",        label: "Cyclone IV E EP4CE10 (E22)" },
    { value: "EP4CE15E22C8",        label: "Cyclone IV E EP4CE15 (E22)" },
    { value: "EP4CE22E22C8",        label: "Cyclone IV E EP4CE22 (E22) — DE0-Nano" },
    { value: "EP4CE30F23C7",        label: "Cyclone IV E EP4CE30 (F23)" },
    { value: "EP4CE40F23C7",        label: "Cyclone IV E EP4CE40 (F23)" },
    { value: "EP4CE55F23C7",        label: "Cyclone IV E EP4CE55 (F23)" },
    { value: "EP4CE75F23C7",        label: "Cyclone IV E EP4CE75 (F23)" },
    { value: "EP4CE115F29C7",       label: "Cyclone IV E EP4CE115 (F29) — DE2-115" },

    // Cyclone V
    { value: "5CSEMA4U23C6",        label: "Cyclone V 5CSEMA4U23 — DE0-Nano-SoC" },
    { value: "5CSEMA5F31C6",        label: "Cyclone V 5CSEMA5F31 — DE1-SoC" },
    { value: "5CGXFC9D6F27C7",      label: "Cyclone V GX 5CGXFC9D6 — DE5a-Net" },

    // Cyclone 10 LP
    { value: "10CL025YU256C8G",     label: "Cyclone 10 LP 10CL025 (U256)" },
    { value: "10CL040YF484C8G",     label: "Cyclone 10 LP 10CL040 (F484)" },

    // MAX 10
    { value: "10M02SCE144C8G",      label: "MAX 10 10M02S (E144)" },
    { value: "10M08DAF484C8G",      label: "MAX 10 10M08D (F484)" },
    { value: "10M50DAF484C7G",      label: "MAX 10 10M50D (F484) — DE10-Lite" },

    // Arria 10
    { value: "10AX115U3F45E2SG",    label: "Arria 10 GX 10AX115U3 (F45)" },
    { value: "10AS066K3F40E2SG",    label: "Arria 10 SX 10AS066K3 (F40)" },

    // Stratix 10
    { value: "1SG280HU1F50E1VG",    label: "Stratix 10 GX 1SG280 (F50)" },
];

export function devicesFor(vendor: "xilinx" | "intel"): DeviceOption[] {
    return vendor === "xilinx" ? XILINX_DEVICES : INTEL_DEVICES;
}
