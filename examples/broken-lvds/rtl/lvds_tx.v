// Drive a divided clock out over an LVDS pair.
module lvds_tx (
    input  wire clk,
    output wire lvds_out_p,
    output wire lvds_out_n
);
    reg [3:0] div = 0;

    always @(posedge clk)
        div <= div + 1;

    OBUFDS obuf (.I(div[3]), .O(lvds_out_p), .OB(lvds_out_n));
endmodule
