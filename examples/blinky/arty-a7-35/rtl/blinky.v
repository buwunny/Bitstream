// Count on four LEDs from the 100 MHz clock; the centre/first button resets.
module blinky (
    input  wire       clk,
    input  wire       rst,
    output wire [3:0] led
);
    reg [27:0] counter = 0;

    always @(posedge clk)
        if (rst)
            counter <= 0;
        else
            counter <= counter + 1;

    assign led = counter[27:24];
endmodule
